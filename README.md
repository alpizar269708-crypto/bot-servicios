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

## CORREGIR UN PAGO REGISTRADO POR ERROR

- Responde al mensaje de confirmación del bot con `errorp` o `errorpago`.
- También puedes responder `errorp` a otro mensaje que mencione de forma inequívoca a la persona.
- O escribe `Nombre errorp` o `errorp Nombre`.

El pago más reciente de esa persona en la cuenta activa se deshace y los servicios vuelven a quedar pendientes en `deudores`.

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

## Menú de bultos, precios y cuenta temporal

- `menu`: muestra las tres secciones disponibles.
- `menu servicios`: comandos de servicios y pagos.
- `menutel`: teléfonos y usuarios.
- `menubultos`: lista de productos, consulta de precios y cuenta temporal.
- En mensaje privado, cualquier usuario puede usar `listap` para guardar productos. Envía una línea por producto con formato `CODIGO Descripción $Precio`, por ejemplo:
  `BC25K Becerra Crecimiento 25 Kilos $245.00`
  `CAGO25K Caballo el 7 leguas Golden 25 Kilos $305.00`
  Si se repite un código, se actualiza su descripción y precio.
- `precio CC25K` o `precio becerra crece`: busca por código o descripción y tolera coincidencias aproximadas.
- `cuenta`: abre una cuenta temporal en memoria durante un máximo de 10 minutos. Cada producto consultado agrega una unidad y actualiza el total; si hay varias coincidencias, pide elegir por número, código o descripción.
- `cerrarcuenta`: cierra la cuenta y muestra el detalle y total. Después de cada producto también puedes responder `sí` para cerrar o `no` para continuar. Las cuentas temporales no se guardan en MongoDB.
