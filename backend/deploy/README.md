# Producción: supervisor de proceso y respaldos

## Supervisor del proceso (bug: nada reiniciaba el server si se caía)

Ya se usa PM2 en el droplet para esto — no se necesita systemd para el
servidor en sí. Solo falta confirmar que PM2 sobrevive un crash *y* un
reinicio del droplet, no solo que se reinicia a mano cuando alguien lo nota:

```bash
pm2 list                 # confirma que el proceso está en "online" y con
                          # "restarts" creciendo si se ha caído antes
pm2 startup              # genera (o confirma) el servicio systemd que hace
                          # que PM2 mismo arranque en cada boot del droplet
pm2 save                 # guarda la lista de procesos actual para que se
                          # restaure automáticamente en ese arranque
```

Si `pm2 startup`/`pm2 save` nunca se corrieron, un reinicio del droplet deja
el proceso caído hasta que alguien entre por SSH — igual que sin PM2. `server.js`
ahora además captura `uncaughtException`/`unhandledRejection` y sale con
código de error en vez de quedar en un estado indefinido, para que PM2 sepa
que debe reiniciarlo.

## Respaldos de bascula.db (bug: no existía ningún respaldo fuera del droplet)

Esto sí es nuevo — `scripts/backup-database.js` + `bascula-backup.service` +
`bascula-backup.timer` (systemd timer, no PM2, porque es una tarea programada
puntual, no un proceso de larga duración).

### Instalación (en el droplet, como root)

```bash
# Ajuste WorkingDirectory/ExecStart en el .service si el código no vive en
# /opt/bascula-central, y el User si no existe un usuario "bascula".
cp backend/deploy/bascula-backup.service /etc/systemd/system/
cp backend/deploy/bascula-backup.timer /etc/systemd/system/

systemctl daemon-reload

# Corre diario vía el timer — no habilitar el .service directamente.
systemctl enable --now bascula-backup.timer
```

`backend/.env` debe existir con `API_KEY` y, para que el respaldo salga del
droplet (no solo quede en disco local), las mismas variables `SPACES_*` que ya
usa la app para adjuntos (ver `storage.js`) — el script sube el respaldo al
mismo bucket, carpeta `backups/`. Sin `SPACES_*`, el respaldo solo protege
contra un `rm` accidental o una migración fallida, no contra la pérdida del
droplet.

Los scripts ahora leen `backend/.env` por su cuenta, así que también funcionan
corriéndolos a mano (antes solo el timer de systemd les pasaba las variables, y
un `node scripts/backup-database.js` manual subía nada en silencio).

El timer corre **cada hora**, no una vez al día: con un respaldo diario a las
04:00, una falla de disco a las 15:00 se lleva un día entero de pesajes.
Localmente solo se guardan 2 días de copias (`BACKUP_LOCAL_RETENTION_DAYS`);
el historial completo vive en Spaces.

### Verificar

```bash
systemctl status bascula-backup.timer
systemctl list-timers bascula-backup.timer   # próxima ejecución
journalctl -u bascula-backup.service         # resultado de la última corrida
```

### Restaurar desde un respaldo

**Use siempre `scripts/restore-database.js`. NO copie el archivo a mano.**

```bash
pm2 stop bascula-backend   # o el nombre que tenga el proceso en pm2 list
cd /opt/bascula-central/backend
# Desde Spaces: descargue el objeto backups/bascula-<timestamp>.db del bucket.
node scripts/restore-database.js backups/bascula-<timestamp>.db --confirm
pm2 start bascula-backend
```

El script imprime cuántas filas trae el respaldo, reemplaza `bascula.db`
(guardando la anterior como `bascula.db.reemplazada-<fecha>`) y vuelve a leer
el archivo restaurado para confirmar que las filas coinciden. Si no coinciden,
sale con error y le dice que NO inicie el servidor.

> **Por qué no basta con `cp`.** La base corre en modo WAL. Si el servidor
> murió de forma sucia (corte de luz, OOM kill, `kill -9`), queda un
> `bascula.db-wal` "caliente" en disco. Copiar el respaldo encima de
> `bascula.db` sin borrar ese `-wal` hace que SQLite lo reproduzca sobre el
> archivo recién restaurado: **el contenido del respaldo se descarta y vuelve
> el de la instancia que se cayó**, y `PRAGMA integrity_check` sigue diciendo
> `ok`. Medido con un respaldo real: 73,000 transacciones restauradas
> quedaron en 0, sin ningún error visible. El script borra `-wal`/`-shm`
> antes de copiar, que es exactamente lo que faltaba.

### Probar la restauración (hágalo periódicamente)

Un respaldo que nunca se restauró no es un respaldo comprobado. Una vez al mes:

```bash
# En una copia, NO en producción.
mkdir -p /tmp/prueba-restauracion && cd /tmp/prueba-restauracion
# ...descargue un respaldo de Spaces aquí y ábralo:
sqlite3 bascula-<timestamp>.db "SELECT COUNT(*) FROM transacciones;"
```

Si el número no se parece al que muestra Reportes en producción, el respaldo
no sirve y hay que averiguar por qué antes de necesitarlo de verdad.

## Borrar los datos de prueba antes de arrancar producción

`scripts/reset-database.js` borra clientes, camiones en patio, transacciones,
recibos externos (corapsa + corapsa_pagos), gastos, planilla (empleados,
asistencia y períodos) y auditoría — deja intacta `companies` (CORAPSA/
AGROTOR/DINANT son nombres de destino reales, no datos de prueba). Toma un
respaldo automático antes de borrar (mismo mecanismo que arriba) y borra los
adjuntos de prueba ya subidos a Spaces para que no queden huérfanos.

```bash
pm2 stop bascula-backend      # detenga el server primero — este script
                               # escribe directo a bascula.db, sin pasar por
                               # la cola de escritura ni la API-key del server
cd /opt/bascula-central/backend
node scripts/reset-database.js --confirm
pm2 start bascula-backend
```

Si `SPACES_*` no está configurado, el script ahora **se niega a correr**: el
respaldo de seguridad quedaría únicamente en el disco que está por vaciarse.
Configure `SPACES_*`, o acepte el riesgo explícitamente agregando
`--allow-local-only-backup`.

Es normal correrlo una sola vez, justo antes de empezar a capturar datos
reales. El respaldo que crea automáticamente antes de borrar queda en
`backups/` y, si `SPACES_*` está configurado, también en el bucket — ahí
queda todo el historial de pruebas por si hace falta consultarlo después.
