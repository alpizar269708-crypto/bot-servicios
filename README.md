# BOT DE SERVICIOS

Bot de WhatsApp para servicios, pagos, transferencias, deudores y ciclos.
Stack: Baileys + MongoDB + Render.

## COMANDOS

!menu
!activarbotservicios
!pag NOMBRE
!transferencia NOMBRE IMPORTE
!deudores
!pagados
!listaservicios
!cuenta nueva MONTO
!cerrar ciclo

Todos son de una palabra salvo las dos excepciones solicitadas: cuenta nueva y cerrar ciclo.

## REGISTRO NATURAL

Se acepta importe antes o después del nombre:
250 Juan
Juan 250
!250 Juan

Se normalizan acentos, mayúsculas y espacios para tolerar dictado y pequeñas variaciones.
Las transferencias se guardan, pero no entran en la suma de servicios.
Los deudores permanecen guardados hasta que se registra su pago.

## MONGODB

Crear una base en MongoDB Atlas, usuario de base de datos y acceso de red para Render.
Guardar la cadena de conexión en MONGO_URI. No subir credenciales a GitHub.

## RENDER

Crear un Background Worker desde este repositorio.
Build: npm install
Start: npm start

Variables: MONGO_URI, MONGO_DB_NAME, OWNER_PHONE, PAIRING_PHONE, MULTIPLIER_250, COMMAND_PREFIX y COLLECTION_NAME.

## WHATSAPP

El primer arranque muestra QR en logs. Si PAIRING_PHONE está configurado, también solicita código de vinculación.
En WhatsApp: Ajustes > Dispositivos vinculados > Vincular un dispositivo > Vincular con número de teléfono.

IMPORTANTE: los datos operativos y las credenciales de la sesión de Baileys se guardan en MongoDB. Esto permite que el Worker de Render pueda reiniciarse sin perder la sesión por depender de almacenamiento local.