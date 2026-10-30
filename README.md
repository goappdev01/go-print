# GO Print

Impresión para cibers y locutorios: el cliente escanea un QR con el móvil, elige sus PDF o fotos, ve el precio y los envía **directo y cifrado** al PC del locutorio mediante WebRTC. El archivo **nunca se guarda en ningún servidor**: vive solo en la memoria de la pestaña del locutorio y se borra al terminar, a los 15 minutos o al cerrarla.

## Cómo funciona

```
Móvil del cliente ──(1) "hola, soy X" ──▶ Supabase Realtime ◀── PC del locutorio
                  ◀──(2) tarifas, aceptar, datos de conexión ──
Móvil ════════════(3) archivo cifrado, P2P (o vía relé TURN cifrado) ═══════▶ PC
```

1. **Estación** (`/estacion`), en el PC del locutorio: muestra un QR con un código de sala.
2. **Cliente** (`/?s=CODIGO`): elige los archivos; las páginas se cuentan en el móvil y se muestra el precio.
3. El empleado ve el pedido y pulsa **Aceptar**.
4. Se abre un túnel WebRTC y el archivo viaja por trozos, con comprobación SHA-256.
5. La estación vuelve a contar las páginas (no se fía del móvil) y muestra **Imprimir / Ver**.

## Desarrollo

```bash
npm install
npm run dev        # http://localhost:5190
```

Sin variables de entorno funciona en **modo local**: estación y cliente solo se encuentran si están en pestañas del mismo navegador. Sirve para probar el flujo.

Para probar con un móvil de verdad necesitas Supabase (ver abajo). El móvil y el PC tienen que abrir la misma URL pública (o la IP del PC en la red local, por ejemplo `http://192.168.1.20:5190`). Ojo: WebRTC y `crypto.subtle` exigen HTTPS fuera de `localhost`, así que para pruebas con móvil lo más fácil es desplegar en Vercel.

## Configuración (`.env.local` o variables en Vercel)

| Variable | Para qué |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Señalización con Supabase Realtime (solo mensajes cortos, nunca el archivo) |
| `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | Relé TURN opcional para cuando no hay conexión directa (móvil con 4G/5G) |

Supabase: crea un proyecto (vale el plan gratuito) y copia en *Project Settings → API* la URL y la clave `anon`. Realtime Broadcast funciona sin crear tablas.

## Despliegue: GitHub + Vercel + `print.goapp.es`

1. Crea un repositorio en GitHub (por ejemplo `go-print`, privado) y súbelo:
   ```bash
   git remote add origin https://github.com/TU_USUARIO/go-print.git
   git push -u origin main
   ```
2. En Vercel: *Add New → Project → importar el repo*. Detecta Vite automáticamente (build `npm run build`, salida `dist`). Añade las variables de entorno.
3. En Vercel → *Settings → Domains*, añade `print.goapp.es`.
4. En el DNS de `goapp.es`, crea un registro **CNAME** `print` → `cname.vercel-dns.com`. Vercel genera el HTTPS solo.

## Pendiente / siguientes fases

- Cuentas de locutorio (Supabase Auth) y canales Realtime privados.
- Credenciales TURN temporales generadas por una función serverless (no fijas en el cliente).
- Registro de pedidos para caja (solo metadatos: páginas, precio y hora; nunca el contenido).
- Envío anticipado "desde casa" con cifrado de extremo a extremo y caducidad corta.
- Impresión silenciosa con un agente local (QZ Tray o propio).

El código original de Raúl se guarda en `referencia-raul/` solo como referencia local y no se sube al repositorio.
