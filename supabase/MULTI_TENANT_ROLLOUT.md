# Migracion multi-tenant por organizaciones

Esta entrega prepara la migracion SQL. Ningun archivo se ejecuta automaticamente
contra Supabase.

## Estado de la auditoria local

El repositorio no contenia migraciones historicas ni definiciones SQL. Solo permite
confirmar las firmas que usa el frontend:

- `register_stock_entry(uuid, integer, integer, text, text)`
- `register_stock_output(uuid, integer, text, text)`
- `register_sale(uuid, integer, integer, text, text)`

La inspeccion remota posterior confirmo los retornos reales:

- `register_stock_entry(...) returns public.products`
- `register_stock_output(...) returns public.products`
- `register_sale(...) returns public.sales`

Tambien confirmo que `public.is_active_member()` es una validacion global del
usuario basada en `public.members`. Se conserva sin modificar y los wrappers la
ejecutan antes de validar la membership de la organizacion.

Las definiciones completas, policies, triggers y constraints actuales solo existen
en el Supabase remoto. Antes de aplicar cualquier migracion se debe ejecutar
`inspection/inspect_current_database.sql` y guardar/revisar todos sus resultados.

## Archivos y orden

1. `inspection/inspect_current_database.sql` (read-only, ejecutar primero).
2. `migrations/20260903000100_add_organization_tenancy.sql`.
3. `migrations/20260903000200_add_tenant_rls.sql`.
4. `migrations/20260903000300_harden_inventory_rpcs.sql`.
5. `validation/validate_multi_tenant.sql` (read-only, ejecutar al final).

Las tres migraciones deben aplicarse durante una ventana de mantenimiento, en el
orden indicado y sin usar la aplicacion entre una y otra. Cada archivo usa una
transaccion; un error revierte por completo ese archivo.

## Migracion 1: estructura y datos

- Valida tablas/columnas requeridas y que todos los `members.user_id` existan en
  `auth.users`.
- Falla si no existe un miembro activo valido para ser owner.
- Crea `organizations` y `organization_members`.
- Agrega `organization_id` nullable a `products`, `sales`,
  `inventory_movements` y `expenses`.
- Crea JeVi con el miembro activo mas antiguo como `owner`.
- Agrega los demas usuarios de `members` como `admin`; conserva su estado activo.
- Asigna JeVi a todos los registros actuales de las cuatro tablas.
- Comprueba que no queden NULL y solo entonces aplica `NOT NULL`.
- Elimina solo la unicidad global de `products.sku`, detectada desde el catalogo,
  y crea `UNIQUE (organization_id, sku)`.
- Crea claves compuestas para impedir referencias cruzadas producto/venta.
- Crea indices con `organization_id` como primera columna cuando otro UNIQUE no
  cubre ya esa busqueda.
- Reutiliza el helper de `products.updated_at` cuando encuentra exactamente uno;
  de lo contrario crea un helper limitado para `organizations.updated_at`.

Datos modificados por el backfill:

- Una fila nueva en `organizations` (`JeVi`, slug `jevi`).
- Una fila por usuario distinto de `members` en `organization_members`.
- `organization_id` en todas las filas actuales de `products`, `sales`,
  `inventory_movements` y `expenses`.
- No se elimina ni reinicia ningun dato operativo.

## Migracion 2: RLS

Helpers:

- `is_organization_member(uuid)` valida usuario globalmente activo y membership
  activa de `auth.uid()`.
- `has_organization_role(uuid, text[])` valida usuario globalmente activo,
  membership y rol activo.
- `shares_active_organization_with(uuid)` permite consultar un perfil cuando el
  usuario comparte una organizacion activa con el perfil solicitado.

Las tres son `SECURITY DEFINER`, tienen `search_path = ''`, no aceptan un usuario
arbitrario y existen para evitar recursion RLS sobre `organization_members`.

Policies creadas:

- `members`: cada usuario autenticado ve su propio perfil; un usuario globalmente
  activo tambien ve perfiles con los que comparte una membership activa. Se
  elimina `"Members can view members"` y se preservan otras policies de members.
- `organizations`: SELECT para miembros; UPDATE para owner/admin. Sin DELETE cliente.
- `organization_members`: SELECT para miembros de la misma organizacion;
  INSERT/UPDATE/DELETE para owner/admin.
- `products`: SELECT para owner/admin/seller. INSERT/UPDATE/DELETE solo para
  owner/admin; INSERT exige `created_by = auth.uid()` y `stock = 0`.
- `sales`: solo SELECT cliente; escrituras mediante RPC.
- `inventory_movements`: solo SELECT cliente; escrituras mediante RPC.
- `expenses`: SELECT para owner/admin/seller. INSERT/UPDATE/DELETE solo para
  owner/admin; INSERT exige `paid_by = auth.uid()`.

Los tres roles pueden ejecutar las RPC de inventario si su usuario esta activo y
la membership del producto tambien esta activa. Seller no recibe ninguna policy
de escritura directa sobre productos, gastos, ventas ni movimientos.

Un trigger impide cambiar las claves de una membership, protege a los owners de
acciones realizadas por admins y bloquea eliminar/desactivar/degradar al ultimo
owner activo. Otros triggers hacen inmutables los IDs de tenant y actor historico.

La migracion reemplaza las policies existentes de las seis tablas tenant-owned.
La inspeccion remota se utilizo para confirmar ese reemplazo. En `members` solo se
elimina la policy SELECT global identificada por nombre; las demas policies de esa
tabla se conservan.

## Migracion 3: RPC y trazabilidad

La migracion no reconstruye formulas desconocidas. Renombra las implementaciones
actuales con sufijo `_legacy_monotenant`, les revoca acceso a `anon` y
`authenticated`, y crea wrappers publicos con las mismas firmas que hoy usa React.

Las definiciones inspeccionadas muestran que las tres RPC no se llaman entre si.
Por eso el renombrado no rompe llamadas internas. Cualquier otra funcion remota
que las invoque por su nombre publico seguira encontrando el wrapper con esa misma
firma; el inspector incluye una consulta adicional para listar esos consumidores.

Cada wrapper:

- exige `auth.uid()`;
- exige que `public.is_active_member()` sea verdadero;
- bloquea y lee el producto real;
- deriva `organization_id` del producto, sin confiar en un tenant enviado;
- exige membership activa;
- llama la implementacion original en la misma transaccion;
- devuelve exactamente el registro retornado por la funcion original
  (`public.products` o `public.sales`).

Los wrappers y las funciones legacy conservan `SECURITY DEFINER` y usan
`search_path = ''`. Todas las referencias no integradas estan calificadas por
esquema. `is_active_member()` no se elimina ni se redefine.

Triggers de defensa en profundidad:

- completan/verifican `organization_id` contra el producto;
- fuerzan `sales.seller_id = auth.uid()`;
- fuerzan `inventory_movements.performed_by = auth.uid()`;
- validan que `movement.sale_id` use la misma organizacion;
- impiden modificar `products.stock` fuera de las tres RPC;
- fuerzan `created_by` y `paid_by` para escrituras autenticadas.

Para mantener el frontend actual temporalmente, una insercion de producto o gasto
sin `organization_id` lo resuelve solo cuando el usuario tiene exactamente una
membership activa. Al pertenecer a dos o mas organizaciones, la operacion falla y
la siguiente etapa del frontend debe enviar la organizacion seleccionada.

## Consideraciones de aplicacion

1. Nuevas FK compuestas fallaran si ya existen relaciones cruzadas o referencias
   huerfanas. Ese fallo es deliberado y no elimina datos.
2. Una cuenta con varias organizaciones necesitara el selector de organizacion del
   frontend antes de crear productos o gastos.

## Estado de preparacion

La inspeccion remota confirmo las RPC, `is_active_member()`, la policy global de
members y `set_updated_at()`. No quedan riesgos criticos nuevos identificados en
el SQL preparado. Las tres migraciones quedan listas para aplicacion manual en el
orden documentado, con backup y ventana de mantenimiento.

## Aplicacion manual en Supabase Dashboard

1. Crear un backup o snapshot verificable del proyecto Supabase.
2. Activar una ventana de mantenimiento y evitar escrituras desde la app.
3. Abrir SQL Editor y ejecutar completo `inspection/inspect_current_database.sql`.
4. Exportar o guardar todos los resultados del inspector.
5. Confirmar firmas, columnas, policies, constraints, triggers y funciones
   relacionadas contra este documento.
6. Abrir una consulta nueva y ejecutar completa la migracion 1.
7. Confirmar que finaliza con `COMMIT`, sin ignorar advertencias ni errores.
8. Ejecutar completa la migracion 2.
9. Ejecutar completa la migracion 3.
10. Ejecutar `validation/validate_multi_tenant.sql`.
11. Comprobar que todos los contadores de NULL y relaciones cruzadas sean cero.
12. Probar las tres RPC con usuarios autenticados antes de reabrir la app.
13. Limpiar la cache de esquema de PostgREST si Supabase no detecta de inmediato
    los wrappers renombrados (`NOTIFY pgrst, 'reload schema';`).

## Pruebas multi-tenant posteriores

Crear Org B (`Perfumes PF`) y su membership de Pepito desde SQL Editor con un UUID
real de `auth.users`. No agregar a Vicente ni Jesus a Org B.

Pruebas con sesiones reales (app o cliente Supabase autenticado):

- Vicente puede leer productos/ventas/movimientos de JeVi y ejecutar las tres RPC
  sobre productos JeVi.
- Vicente puede ver una venta hecha por Jesus y su `seller_id` sigue siendo Jesus.
- Jesus ve el mismo stock JeVi; al vender, `seller_id` queda igual a su propio UID.
- Pepito ve solo datos de Perfumes PF.
- Pepito recibe error al consultar directamente una fila JeVi por ID.
- Pepito recibe error al ejecutar una RPC con un `product_id` JeVi.
- Intentar insertar una venta o movimiento directo no produce ninguna fila.
- Alterar `organization_id`, `seller_id`, `created_by`, `performed_by` o `paid_by`
  desde DevTools no permite suplantacion ni relaciones cruzadas.
- Vicente tampoco puede leer ni operar datos de Perfumes PF.

Pruebas de integridad desde SQL Editor, idealmente dentro de una transaccion que se
revierte:

- Intentar relacionar una venta JeVi con un producto Perfumes PF: debe fallar la FK
  compuesta.
- Intentar relacionar un movimiento JeVi con una venta Perfumes PF: debe fallar.
- Crear `PROD-001` una vez en cada organizacion: debe funcionar.
- Crear un segundo `PROD-001` dentro de JeVi: debe fallar la constraint UNIQUE.
- Intentar desactivar al unico owner: debe fallar el trigger de ultimo owner.

## No ejecutar

- `supabase db reset`.
- `DROP TABLE` sobre tablas actuales.
- Las migraciones fuera del orden documentado.
- La migracion 1 de forma aislada y reabrir la aplicacion antes de completar 2 y 3.
- SQL de prueba destructivo fuera de una transaccion con `ROLLBACK`.
- Ninguna migracion hasta revisar la salida real del inspector remoto.

## Siguiente etapa del frontend

- Cargar memberships y organizaciones al iniciar sesion.
- Mantener `activeOrganizationId` como estado de sesion de la aplicacion.
- Agregar selector cuando haya mas de una organizacion.
- Filtrar explicitamente lecturas por `organization_id` como defensa adicional y
  para consultas mas eficientes; RLS seguira siendo la frontera de seguridad.
- Incluir `organization_id` al crear productos y gastos.
- Mantener las firmas actuales de las tres RPC mientras deriven el tenant desde el
  producto, o versionarlas despues si se decide exigir el argumento explicito.
- Regenerar tipos Supabase para incluir `organizations`, `organization_members` y
  las nuevas columnas.
- Probar estados sin membership, membership inactiva y cambio de organizacion.
