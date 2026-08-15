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

### Verificar

```bash
systemctl status bascula-backup.timer
systemctl list-timers bascula-backup.timer   # próxima ejecución
journalctl -u bascula-backup.service         # resultado de la última corrida
```

### Restaurar desde un respaldo

```bash
pm2 stop bascula-backend   # o el nombre que tenga el proceso en pm2 list
# Desde Spaces: descargue el objeto backups/bascula-<timestamp>.db del bucket.
cp bascula-<timestamp>.db /opt/bascula-central/backend/bascula.db
pm2 start bascula-backend
```
