# Desarrollo sin tocar producción

La báscula trabaja con datos reales todo el día. Todo cambio se prueba primero en
el **sandbox** (servidor y base de datos de prueba en esta computadora) y se
despliega **después de las 7:00 p. m.**, salvo que sea 100 % seguro antes.

## Comandos (desde `frontend/`)

| Comando | Qué abre | Datos |
|---|---|---|
| `npm run dev` (o `npm start`) | Servidor sandbox + la app, en una sola terminal | De prueba (`backend/sandbox/`) |
| `npm run sandbox:load-backup -- <archivo.db>` | Carga una copia de un respaldo en el sandbox | Copia local |
| `npm run start:prod` | Solo la app, contra el servidor real | **Reales** (marco rojo) |

Cerrar la ventana de la app, o Ctrl+C en la terminal, detiene todo.

## Cómo saber dónde está

- **Sandbox:** marco ámbar alrededor de la ventana y la etiqueta
  `SANDBOX · 127.0.0.1:3100` junto al título.
- **Datos reales desde desarrollo** (`npm run start:prod`): marco y etiqueta rojos,
  `DATOS REALES`.
- **App instalada en la báscula:** sin marco. Siempre usa producción.

## Qué lo protege

1. **Sandbox por defecto.** La app de desarrollo solo llega a producción con
   `npm run start:prod`. La app instalada no cambió: siempre usa producción.
2. **Cola sin conexión separada.** El sandbox guarda su cola de pesadas pendientes,
   la configuración de la báscula y su almacenamiento en su propia carpeta
   (`~/.config/bascula-central-sandbox`), así que una pesada de prueba nunca se
   reenvía a producción.
3. **Marco y etiqueta de color** (arriba).
4. **Base propia y sin Spaces.** El servidor sandbox usa solo
   `backend/sandbox/bascula-sandbox.db`, escucha solo en esta computadora y **no
   arranca** si encuentra credenciales de Spaces (`SPACES_*`). Esas credenciales
   van únicamente en el `.env` del droplet: con ellas, borrar un registro de prueba
   borraría su archivo real.

## Probar con datos realistas

1. Copie un respaldo desde el droplet (para producción es solo lectura):
   ```bash
   scp root@<droplet>:/root/weight_software/backend/backups/<archivo>.db ~/Descargas/
   ```
   Para uno al minuto, en el droplet desde `backend/`: `node scripts/backup-database.js`.
2. Con el sandbox cerrado: `npm run sandbox:load-backup -- ~/Descargas/<archivo>.db`
3. `npm run dev`. El servidor actualiza la estructura de la base al arrancar: si una
   migración falla, falla aquí y no en producción.

Los adjuntos de producción (fotos y PDF) viven en Spaces y no se abren en el
sandbox. Para empezar con una base vacía, borre la carpeta `backend/sandbox/`.

## Desplegar (después de las 7:00 p. m.)

1. Probado en el sandbox, de preferencia con un respaldo reciente.
2. **Servidor primero.** Suba los commits a `main` y, en el droplet
   (`/root/weight_software/backend`):
   ```bash
   node scripts/backup-database.js
   git pull
   npm ci                      # solo si cambiaron las dependencias
   pm2 restart bascula-backend
   ```
   Luego abra la app real y revise el cambio. Para revertir:
   `git checkout <commit anterior>` y `pm2 restart bascula-backend`. Restaure el
   respaldo (`scripts/restore-database.js`) solo si los datos se dañaron.
3. **Luego la app.** Suba la versión en `frontend/package.json`, haga commit y
   publique la etiqueta: `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub
   Actions publica la versión; la báscula la instala la próxima vez que se abra la
   app (pregunta antes de reiniciar).
4. Los cambios del servidor deben seguir funcionando con la app ya instalada, así
   el orden y la hora del despliegue nunca dejan a la báscula sin servicio.
