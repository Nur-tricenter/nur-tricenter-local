# Guía de presentación — Proyecto final Nur-Tricenter

Guion para presentar la plataforma con la consola demo (**http://localhost:15100**).
Duración objetivo: **18–20 minutos + preguntas**. Todo se muestra desde una sola pestaña del navegador.

> Idea central que el jurado debe llevarse: *cinco microservicios independientes, cada uno con su
> base de datos, que se comunican por un API Gateway y por eventos en RabbitMQ, con descubrimiento
> en Consul, seguridad con JWT y outbox para no perder eventos.*

---

## 1. Antes de presentar (30 min antes)

1. Levantar todo: `nur-tricenter-local\scripts\start-stack.ps1`.
2. Confirmar contenedores sanos: `docker ps` → todos `healthy`, incluido `nur-tricenter-demo-console`.
3. Abrir `http://localhost:15100` y revisar la barra superior: las 6 píldoras (Identity, MS1–MS5) en línea.
4. **Ensayo en caliente:** en *Recorrido de un pedido* pulsar **Ejecutar todo** una vez. Esto calienta
   los servicios (el primer recorrido tras reiniciar puede tardar más en el paso 3) y deja filas en
   *Outbox transaccional* para mostrar. Luego **Empezar de nuevo** (la página no borra datos, solo reinicia el recorrido).
5. Navegador en pantalla completa (F11), zoom 100–110 %. Cerrar notificaciones.
6. Tener una terminal abierta para el paso de *Service Discovery* (`docker stop` / `docker start`).
7. **Plan B:** si algo del stack falla en vivo, marcar **Datos simulados** en la barra lateral. La consola
   reproduce el mismo flujo en el navegador (mismas rutas, códigos y eventos). Decirlo con naturalidad:
   "esto es la misma secuencia, simulada en el navegador".

### Reparto sugerido (trabajo en grupo)

| Bloque | Quién |
|---|---|
| Apertura + mapa + gateway/Consul | Integrante que armó la plataforma (gateway / local stack) |
| Seguridad | Integrante de Identity / kernels |
| Recorrido, paso a paso | Cada dueño narra los pasos de **su** microservicio (MS1…MS5) |
| Eventos + outbox | Dueños de MS2 / MS5 (los que más publican) |
| Requisitos + cierre | Quien abrió |

---

## 2. Guion

### 0. Apertura (1 min) — vista *Mapa del sistema*

> "Nur-Tricenter es una plataforma para una clínica nutricional: registra pacientes, arma planes de
> comidas, cobra el contrato, produce los paquetes diarios y los entrega a domicilio. Cada parte es un
> microservicio de un integrante del grupo."

### 1. Arquitectura (3 min) — *Mapa del sistema*

Señalar en este orden:
- **Navegador → API Gateway (YARP, puerto 15005):** "es la única puerta de entrada; ningún servicio se expone directo".
- **Consul (arriba):** líneas punteadas violetas = cada servicio se registra solo.
- **Estaciones MS1–MS5 + Identity:** cada una con **su propia base de datos** (texto `BD …`).
- **Bus de RabbitMQ (derecha):** "los servicios no se llaman para avisar cambios; publican eventos".
- **Punteado fino entre estaciones:** las pocas llamadas REST internas (MS3→MS1, MS3→MS4, MS4→MS2).
- **Clic en MS4 Calendario:** panel con qué publica y qué consume, ruta en el gateway, seguridad.
- **Shared kernels:** "Access, Security e Integration son paquetes NuGet comunes: mismos permisos,
  misma validación JWT y los mismos contratos de eventos en todos los servicios".

### 2. Seguridad (3 min) — *Identidad y seguridad*

1. Clic en **admin**: mostrar el JWT (tres colores = header, payload, firma), emisor, vencimiento y la lista de scopes.
2. Clic en **ms4-service**: "una cuenta de servicio solo tiene `catalog.mealPlan:read`, lo mínimo que MS4 necesita para pedir el menú a MS2".
3. **Probar todos los accesos** y leer la tabla:
   - **401** sin token → no autenticado.
   - **403** con `ms4-service` → autenticado pero sin el scope.
   - **200/201/204** con admin → autorizado.
4. Remarcar: "el gateway solo enruta; **cada servicio valida el token** con el kernel Security y exige su scope por endpoint".
5. Ser transparentes: "MS3 y MS5 todavía aceptan llamadas anónimas; está registrado como deuda (gaps X-11 y X-03)".

### 3. Recorrido de un pedido (6–7 min) — *Recorrido de un pedido*

Usar **Ejecutar paso N** uno por uno (no *Ejecutar todo*) para narrar. Cada paso muestra la petición y
la respuesta reales; el mini‑mapa anima la llamada y el tablero de abajo muestra los eventos.

| Paso | Qué decir | Qué señalar |
|---|---|---|
| 1 Iniciar sesión | "Todo empieza con un token de Identity." | La llamada `POST /auth/login` |
| 2 Registrar paciente (MS1) | "MS1 guarda al paciente y publica `paciente-published` desde su outbox." | Evento en el tablero |
| 3 Recetas y plan (MS2) | "MS2 crea el plan de 15 días; su modelo de lectura se actualiza de forma eventual, por eso esperamos." | Trenes verdes MS2 → MS3/MS4 (`meal-plan-published`) |
| 4 Contratar y cobrar (MS3) | "MS3 **solo acepta el contrato cuando ya recibió el plan por evento**, y valida al paciente contra MS1 por REST." | Reintento hasta 201 |
| 5 Calendario creado (MS4) | "Al cobrar, MS3 pide a MS4 crear el calendario con su cuenta de servicio `ms3-service`: 15 días pendientes." | Respuesta con los días |
| 6 Dirección y menú (MS4) | "El paciente pone su dirección; MS4 resuelve el menú de mañana preguntando a MS2." | Menú en la respuesta de `active-tomorrow` |
| 7 Repartidor y ruta (MS5) | "MS5 crea repartidor y ruta; publica `courier-created` y `route-created`." | Trenes azules sin consumidores |
| 8 Producir y validar (MS3) | "MS3 arma, etiqueta y valida el paquete: publica `package-validated`." | Tren amarillo MS3 → MS5 |
| 9 Entrega asignada | "Aquí el navegador **no llama a nadie**: MS5 consume el evento, agrega la entrega a la ruta y publica `delivery-added-to-route`, que consume MS4. Dos saltos asíncronos." | Tablero: los dos eventos en cadena |
| 10 Entregar (MS5) | "El repartidor cierra la entrega con foto y firma." (Opcional: elegir **Fallido** en *Resultado*.) | `delivery-completed` |
| 11 Día cerrado (MS4) | "MS4 cierra el día **solo por el evento** de MS5; nadie lo cambia a mano. Pasamos por los 5 microservicios." | Estado `Delivered` |

### 4. Service Discovery en vivo (2 min) — *Registro de servicios*

**Hacerlo después del recorrido**, porque apagar un servicio rompería el flujo.

1. Mostrar la tabla: nombre en Consul, instancia, health checks, ruta del gateway.
2. En la terminal: `docker stop nur-tricenter-catalog-api`.
3. En unos segundos la fila pasa a **caído**, la píldora MS2 de arriba y su estación en el mapa se ponen rojas.
   "Consul detectó que su /health no responde; el gateway deja de enrutarlo (tarda hasta 30 s en releer Consul)."
4. `docker start nur-tricenter-catalog-api` → vuelve a **en línea** solo, sin tocar configuración.

### 5. Eventos del broker (2 min) — *Eventos del broker*

- Filtrar por **MS5** o **MS2** y abrir un evento: payload real y colas destino.
- Tabla de colas: "convención `{consumidor}.{exchange}`; un exchange **fanout** por evento, así cada consumidor recibe su copia; *Pendientes* en 0 = el servicio va al día".
- Explicar cómo lo ve la consola: "tiene su propia cola enganchada a todos los exchanges; recibe una copia sin quitarle mensajes a nadie".

### 6. Outbox transaccional (2 min) — *Outbox transaccional*

- Diagrama: "el dato y el evento se guardan **en la misma transacción**; un worker publica después. Si el broker está caído, el evento espera en la tabla; no se pierde ni se publica un evento de algo que no se guardó."
- Tabla izquierda: filas del recorrido (`CourierCreated`, `DeliveryCompleted`…) en **publicado**.
- Tabla derecha (inbox): "los consumidores anotan cada mensaje procesado; si RabbitMQ lo entrega dos veces, el segundo se ignora (idempotencia)".

### 7. Cierre (1 min) — *Requisitos del proyecto*

Recorrer la lista: cada requisito tiene su vista. Seguridad aparece como **parcial** a propósito: mejor
decirlo nosotros que el jurado. El Saga fue retirado de los requisitos.

> "En resumen: gateway como única entrada, descubrimiento automático con Consul, comunicación
> asíncrona por RabbitMQ con outbox e inbox, JWT con scopes y cinco microservicios integrados de punta a punta."

---

## 3. Preguntas probables

| Pregunta | Respuesta corta |
|---|---|
| ¿Qué pasa si RabbitMQ se cae? | Los servicios siguen guardando; los eventos quedan en su outbox y el worker los publica cuando vuelve. |
| ¿Y si un evento llega dos veces? | El inbox del consumidor registra el id del mensaje y descarta el duplicado. |
| ¿Por qué el gateway no valida el JWT? | Cada servicio decide sus permisos (scopes por endpoint); el gateway solo enruta. Validar en el gateway es una mejora posible, no reemplaza la validación del servicio. |
| ¿Por qué un exchange por evento? | Fanout: agregar un consumidor nuevo es solo crear su cola, sin tocar al publicador. |
| ¿Por qué MS2 tarda en mostrar el plan? | Separa escritura y lectura (modelo de lectura proyectado por su worker): consistencia eventual. |
| ¿Cómo se comparten los contratos? | Paquete NuGet `Nur.Tricenter.Integration` (kernel compartido, versionado). |
| ¿Cómo encuentra el gateway a los servicios? | Lee Consul cada 30 s y arma rutas `/api/{servicio}/**` solo hacia instancias sanas. |
| ¿Por qué hay llamadas REST entre servicios? | Solo donde se necesita respuesta inmediata (validar paciente, crear calendario, menú del día); los avisos de cambio van por eventos. |
| ¿La consola lee bases de datos? | Solo lectura y solo para mostrar las tablas outbox/inbox. Todo lo demás, incluidas las búsquedas de calendario, paquetes y entregas, pasa por el gateway con los endpoints de consulta de cada servicio. |
| ¿Qué falta? | JWT en MS3 y MS5, y relacionar el usuario del token con el paciente (autorización por objeto). |

---

## 4. Si algo falla en vivo

| Síntoma | Qué hacer |
|---|---|
| Paso 3 o 4 espera mucho | Normal hasta ~60–90 s tras un reinicio (proyecciones por evento). Seguir hablando del evento que se espera. |
| Un paso falla con 404 justo después de reiniciar un servicio | El gateway aún no releyó Consul (≤30 s). Reintentar con **Ejecutar paso N**. |
| Barra superior con servicios grises | La consola no llega a Consul: revisar `docker ps`. |
| Tablero dice "reconectando con el broker" | RabbitMQ reiniciándose; la consola se reconecta sola cada 5 s. |
| Nada responde | Marcar **Datos simulados** y continuar la demo con el mismo guion. |
