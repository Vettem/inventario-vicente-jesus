# Inventario Vicente y Jesus

Aplicacion web MVP para inventario compartido entre Vicente y Jesus. Usa React, Vite, TypeScript, Supabase Auth y tablas/RPC ya existentes en Supabase.

## Requisitos

- Node.js 20 o superior
- Proyecto Supabase ya creado
- Variables de entorno:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`

## Instalacion

```bash
npm install
```

## Configuracion

Crear un archivo `.env.local` en la raiz del proyecto:

```bash
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu_clave_publicable
```

`.env` y `.env.local` estan ignorados por Git.

## Ejecucion

```bash
npm run dev
```

## Compilar

```bash
npm run build
```

## Supabase

La app no crea ni modifica tablas, columnas, politicas RLS ni funciones. Consume las tablas existentes:

- `members`
- `products`
- `sales`
- `inventory_movements`
- `expenses`

Y llama las RPC existentes:

- `register_stock_entry`
- `register_sale`
- `register_stock_output`

Los mapeos de columnas y variantes de argumentos RPC estan concentrados en `src/lib/schema.ts`. Si tu esquema usa nombres distintos para campos como nombre, stock, costo, precio o vendedor, ajusta ese archivo sin cambiar la UI.
