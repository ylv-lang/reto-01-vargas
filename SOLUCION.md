# SOLUCION.md

## 1. Problema en una frase

Automatizar la preparación de registros de proveedores para reducir la transcripción manual de información, identificar faltantes y soportes pendientes, generar los formularios requeridos y entregar un paquete trazable para revisión antes de cualquier acción de envío.

---

## 2. Arquitectura

La solución está implementada como un agente conversacional independiente compuesto por una interfaz web, un backend, un ciclo de agente con herramientas tipadas y un adaptador desacoplado del proveedor de LLM.

```text
┌──────────────────────────────┐
│        web/index.html        │
│        Chat conversacional   │
└──────────────┬───────────────┘
               │ POST /api/chat
               ▼
┌──────────────────────────────┐
│        src/server.ts         │
│ API + ciclo del agente       │
│                              │
│ - historial de sesión        │
│ - límite de iteraciones      │
│ - confirmación pendiente     │
│ - validación de argumentos   │
│ - control de ejecución       │
└──────────────┬───────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌───────────────┐  ┌─────────────────┐
│ LLM Adapter   │  │ Herramientas    │
│               │  │ Zod tipadas     │
│ OpenAI / Mock │  │ proveedor.ts    │
└───────────────┘  └────────┬────────┘
                            │
                            ▼
                ┌────────────────────────┐
                │ fixtures/reto-01/      │
                │                        │
                │ - solicitudes          │
                │ - glosario             │
                │ - maestro              │
                │ - soportes             │
                └───────────┬────────────┘
                            │
                            ▼
                     ┌────────────┐
                     │   out/     │
                     │ resultados │
                     │ + logs     │
                     └────────────┘
```

### Componentes principales

| Componente                                 | Responsabilidad                                               |
| ------------------------------------------ | ------------------------------------------------------------- |
| `web/index.html`                           | Interfaz de chat para interactuar con el agente               |
| `src/server.ts`                            | API HTTP, sesiones, ciclo del agente y controles de seguridad |
| `src/llm/adapter.ts`                       | Contrato común para proveedores de LLM                        |
| `src/llm/openai.ts`                        | Implementación del adaptador OpenAI                           |
| `src/llm/mock.ts`                          | Adaptador determinista para pruebas locales                   |
| `src/tools/proveedor.ts`                   | Herramientas de negocio                                       |
| `agent/prompt.md`                          | Reglas de comportamiento del agente                           |
| `modulo/agent.md`                          | Versión reutilizable del agente                               |
| `modulo/skill/registro-proveedor/SKILL.md` | Conocimiento del proceso                                      |
| `modulo/tools/proveedor.ts`                | Reexportación de las herramientas                             |
| `fixtures/reto-01/`                        | Fuente de datos ficticios                                     |
| `out/`                                     | Formularios, paquetes, logs y simulaciones                    |

La clave del modelo solamente se utiliza en el backend mediante variables de entorno. El navegador nunca recibe `OPENAI_API_KEY`.

---

## 3. Ciclo del agente

El ciclo comienza cuando el usuario envía un mensaje desde la interfaz web.

### Flujo normal

```text
Usuario
   │
   ▼
POST /api/chat
   │
   ▼
Agregar mensaje al historial
   │
   ▼
Enviar historial + herramientas al LLM
   │
   ▼
¿El LLM solicita una herramienta?
   │
   ├── No ──► respuesta final al usuario
   │
   └── Sí
         │
         ▼
   Validar argumentos con Zod
         │
         ▼
   Ejecutar herramienta
         │
         ▼
   Registrar resultado
         │
         ▼
   Devolver resultado al LLM
         │
         └──────► repetir
```

El número de iteraciones está limitado mediante `MAX_TOOL_ITERATIONS`, cuyo valor por defecto es 25.

Esto evita que un error del modelo produzca un ciclo infinito de llamadas.

### Herramientas disponibles

| Herramienta                    | Función                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `proveedor_leer_solicitud`     | Lee la solicitud y determina plantilla, país, cliente, campos y soportes     |
| `proveedor_mapear_campos`      | Relaciona las etiquetas de la plantilla con el maestro de datos              |
| `proveedor_generar_formulario` | Genera XLSX, PDF o valores para portal                                       |
| `proveedor_armar_paquete`      | Construye el paquete, checklist y borrador de correo                         |
| `proveedor_simular_envio`      | Crea únicamente un archivo de simulación después de superar las validaciones |

---

## 4. Reglas de datos y mapeo

El LLM no es considerado una fuente de verdad para los datos empresariales.

La información procede de:

1. Solicitud del caso.
2. Glosario de campos.
3. Maestro de información.
4. Índice de soportes.

El prompt establece explícitamente que el agente no debe inventar ni completar valores mediante inferencia.

### Identificadores tributarios

Se implementó la regla definida en el reto:

| País | Identificador esperado |
| ---- | ---------------------- |
| CO   | NIT                    |
| EC   | RUC                    |
| PE   | RUC                    |
| PA   | RUC                    |
| HN   | RTN                    |

Como el maestro contiene información colombiana, cuando una plantilla extranjera solicita un identificador que no corresponde directamente al NIT disponible, el valor se marca como `requiere_confirmacion`.

Ejemplo:

```text
RUC
Valor disponible: 900123456
Estado: requiere_confirmacion
Nota: identificador extranjero
```

De esta forma, el sistema no presenta el dato como definitivamente válido.

---

## 5. Confirmación y control de acciones externas

Esta es una de las partes más importantes de la solución.

La aplicación no realiza envíos externos reales. `proveedor_simular_envio` únicamente genera:

```text
out/<caso>/ENVIO-SIMULADO.md
```

El archivo deja explícito que no se realizó un envío externo.

### Controles implementados

La ejecución está protegida por varias validaciones.

#### Primera barrera: argumento de la herramienta

La herramienta exige:

```text
confirmado = true
```

Si el modelo intenta ejecutar la herramienta sin ese valor, la operación falla.

#### Segunda barrera: validación del backend

El backend mantiene el estado de una confirmación pendiente por sesión.

Cuando el agente termina un turno solicitando confirmación, el servidor conserva:

```text
sessionId
caso
```

En el siguiente mensaje, el backend verifica que exista una confirmación explícita.

Se reconocen expresiones como:

```text
sí
si
confirmo
confirmado
confirmada
adelante
procede
proceder
ok
de acuerdo
```

La confirmación no depende exclusivamente de que el modelo recuerde correctamente el contexto anterior.

#### Tercera barrera: paquete listo

Incluso después de recibir una confirmación válida, el backend vuelve a ejecutar la validación del paquete.

Debe cumplirse:

```text
listo_para_firma === true
```

Si existen campos faltantes, campos pendientes de confirmación o soportes requeridos ausentes/vencidos, la simulación se bloquea.

Por lo tanto, el flujo real es:

```text
Usuario solicita procesamiento
          │
          ▼
Generar paquete
          │
          ▼
¿Está listo para firma?
      │          │
     NO         SÍ
      │          │
      ▼          ▼
Bloquear     Solicitar
             confirmación
                  │
                  ▼
          Usuario confirma
                  │
                  ▼
        Backend valida sesión
                  │
                  ▼
       Backend vuelve a validar
             el paquete
                  │
          ┌───────┴────────┐
          │                │
       NO listo          Listo
          │                │
          ▼                ▼
       Bloquear       Crear ENVIO-
                      SIMULADO.md
```

Este diseño evita depender únicamente de una instrucción enviada por el LLM.

---

## 6. Elección del modelo

Se implementó una abstracción mediante `LlmAdapter`.

Esto permite separar el ciclo del agente del proveedor concreto.

### Proveedor implementado

OpenAI mediante:

```text
src/llm/openai.ts
```

Modelo configurable:

```text
OPENAI_MODEL=gpt-4o-mini
```

La clave se configura mediante:

```text
OPENAI_API_KEY
```

y únicamente es utilizada por el backend.

### Modo Mock

También existe:

```text
src/llm/mock.ts
```

que permite ejecutar y probar el proyecto sin consumir una API externa.

Esto es especialmente útil para:

* desarrollo local;
* demostraciones;
* pruebas deterministas;
* validación de herramientas;
* escenarios donde no existe crédito disponible en el proveedor LLM.

El costo real por caso depende del modelo utilizado y del número de tokens consumidos. Por ese motivo no se fija una cifra artificial en esta documentación.

---

## 7. Diseño de portal web

El reto contempla un posible escenario donde el cliente utilice un portal web con usuario y contraseña.

En esta implementación el portal real está fuera de alcance.

El agente genera:

```text
valores-portal.md
```

con los valores que el usuario podría copiar al portal.

### Alternativa para producción

Para una implementación productiva se podría utilizar:

* navegador controlado mediante Playwright;
* RPA;
* extensión de navegador;
* integración API oficial del portal, si existe.

La automatización mediante navegador presenta limitaciones:

* CAPTCHA;
* MFA;
* cambios de layout;
* selectores modificados;
* validaciones dinámicas;
* sesiones expiradas.

### Credenciales

Las credenciales nunca deberían almacenarse:

* en el repositorio;
* en el prompt;
* en `fixtures`;
* en logs;
* en respuestas del LLM.

El usuario debería introducirlas mediante un mecanismo seguro o un gestor de secretos.

### División de responsabilidades

El agente:

1. prepara los datos;
2. identifica los campos;
3. valida faltantes;
4. prepara valores copiable;
5. puede guiar al usuario durante el proceso.

El usuario:

1. proporciona las credenciales;
2. atiende CAPTCHA/MFA;
3. revisa la información;
4. realiza el clic final de envío.

En particular, el clic de envío no se automatiza en esta solución.

---

## 8. Decisiones y trade-offs

### 8.1 Herramientas deterministas para los datos

Se decidió que el LLM coordine el proceso, pero no sea la fuente de verdad de los datos empresariales.

**Alternativa descartada:** permitir que el modelo construyera directamente los formularios.

**Motivo:** aumentaría el riesgo de inventar o transformar incorrectamente información empresarial.

---

### 8.2 Adaptador independiente del proveedor LLM

Se creó:

```text
src/llm/adapter.ts
```

con una interfaz común.

**Alternativa descartada:** utilizar directamente el SDK de OpenAI desde `server.ts`.

**Motivo:** el desacoplamiento permite utilizar Mock y posteriormente otro proveedor sin modificar el ciclo principal.

---

### 8.3 Persistencia basada en archivos

Los resultados se almacenan en:

```text
out/<caso>/
```

**Alternativa descartada:** incorporar una base de datos.

**Motivo:** el reto requiere una solución pequeña, autocontenida y fácil de ejecutar localmente.

En producción sería recomendable utilizar una persistencia centralizada.

---

### 8.4 Interfaz HTML simple

Se utilizó:

```text
web/index.html
```

sin framework frontend.

**Alternativa descartada:** React u otro framework.

**Motivo:** el objetivo del reto es demostrar el agente, sus herramientas y controles, no construir un frontend complejo.

---

### 8.5 Confirmación controlada por backend

No se dejó la confirmación exclusivamente en manos del prompt.

**Alternativa descartada:** confiar únicamente en que el LLM enviara `confirmado=true`.

**Motivo:** una regla crítica de seguridad debe ser validada por código y no depender exclusivamente del comportamiento probabilístico del modelo.

Además, antes de crear el archivo de simulación se vuelve a comprobar que el paquete esté listo.

---

### 8.6 Reconstrucción de formularios

Las plantillas recibidas se describen mediante estructuras de campos/coordenadas, por lo que se reconstruyen los archivos XLSX.

**Alternativa descartada:** intentar preservar un libro XLSX binario que no está disponible como plantilla original.

**Limitación:** una versión productiva debería trabajar directamente sobre la plantilla original para preservar estilos, fórmulas, formatos y validaciones.

---

## 9. Supuestos

* Los datos incluidos en los fixtures son ficticios.
* Los fixtures constituyen la fuente de verdad para esta prueba.
* El maestro contiene información colombiana de Periferia.
* Los identificadores extranjeros requieren confirmación cuando no existe una fuente correspondiente en el maestro.
* Las plantillas se reconstruyen a partir de las estructuras entregadas.
* Los soportes incluidos en los fixtures representan el escenario de prueba.
* Los portales reales están fuera del alcance.
* No existen integraciones externas de firma, correo o carga de documentos.
* `ENVIO-SIMULADO.md` representa exclusivamente una simulación.
* El usuario debe revisar la información antes de cualquier acción posterior.

---

## 10. Cobertura

| Historia / requisito                              | Estado           | Evidencia / pendiente                                                 |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| HU-1 Leer solicitud                               | Hecho            | `proveedor_leer_solicitud`                                            |
| HU-2 Mapear campos                                | Hecho            | Glosario + maestro + clasificación de llenos/faltantes/confirmaciones |
| HU-3 Generar formulario                           | Hecho            | XLSX/PDF/valores para portal                                          |
| HU-4 Construir paquete                            | Hecho            | Checklist, formulario y borrador de correo                            |
| HU-5 Detectar soportes ausentes/vencidos          | Hecho            | Validación durante `proveedor_armar_paquete`                          |
| HU-6 Confirmación                                 | Hecho            | Estado pendiente por sesión + validación backend                      |
| HU-7 Bloqueo de envío si el paquete no está listo | Hecho            | Segunda validación de `listo_para_firma`                              |
| HU-8 Simulación de envío                          | Hecho            | Generación de `ENVIO-SIMULADO.md`                                     |
| HU-9 Registro de ejecuciones                      | Hecho            | `out/<caso>/log.jsonl`                                                |
| HU-10 Interfaz conversacional                     | Hecho            | `web/index.html`                                                      |
| HU-11 Adaptador LLM                               | Hecho            | OpenAI + Mock                                                         |
| HU-12 Portal web real                             | Fuera de alcance | Se generan valores copiable                                           |
| HU-13 Firma electrónica real                      | Fuera de alcance | Requiere integración externa                                          |
| HU-14 Envío externo real                          | Fuera de alcance | La solución solamente simula                                          |
| HU-15 Pruebas automatizadas exhaustivas           | Parcial          | Se requiere ampliar suite de regresión                                |

### Validación realizada

#### Caso positivo: `co-industrias-delta`

El caso fue procesado correctamente:

```text
campos faltantes = 0
campos por confirmar = 0
formulario disponible = true
listo_para_firma = true
```

Después de la confirmación explícita del usuario se generó:

```text
out/co-industrias-delta/ENVIO-SIMULADO.md
```

El resultado indicó:

```text
envio_realizado = false
confirmacion_validada = true
```

Por lo tanto, se verificó el flujo completo:

```text
procesamiento
→ mapeo
→ generación
→ paquete listo
→ confirmación
→ simulación
```

---

#### Caso negativo: `ec-corp-andina`

El caso contiene información extranjera y elementos pendientes.

El paquete fue identificado como:

```text
listo_para_firma = false
```

Entre los problemas detectados se encuentran:

```text
campo faltante:
Número de contribuyente especial

campo pendiente de confirmación:
RUC

soporte requerido ausente:
certificado_cumplimiento_tributario
```

Posteriormente se envió:

```text
Sí, confirmo el envío
```

El backend recibió correctamente la confirmación, pero `proveedor_simular_envio` volvió a comprobar el estado del paquete y bloqueó la operación.

Resultado:

```text
ok = false
```

con el mensaje:

```text
El paquete no está listo para firma o envío.
Existen campos faltantes, datos pendientes de confirmación
o soportes requeridos ausentes.
```

Este escenario demuestra que una confirmación explícita no permite saltarse las validaciones del paquete.

---

## 11. Uso de IA

Se utilizó ChatGPT como asistente durante el desarrollo para:

* interpretar el enunciado;
* revisar la arquitectura;
* proponer estructuras de TypeScript;
* analizar errores de compilación;
* revisar el ciclo del agente;
* mejorar controles de confirmación;
* revisar escenarios de prueba;
* actualizar la documentación.

Las propuestas generadas por IA fueron revisadas y adaptadas durante la implementación.

Un ejemplo importante fue la validación del envío simulado. Inicialmente la confirmación dependía principalmente del flujo del modelo. Durante las pruebas se identificó que un caso con información pendiente podía llegar a la herramienta de simulación después de recibir confirmación.

La solución se modificó para que el backend:

1. mantenga el estado de confirmación;
2. valide explícitamente la confirmación;
3. vuelva a construir/verificar el paquete;
4. compruebe `listo_para_firma`;
5. solamente entonces cree el archivo de simulación.

La implementación final fue probada tanto con un caso válido como con un caso bloqueado.

---

## 12. Riesgos y mitigaciones

### 12.1 Alucinación de datos

**Riesgo:** el LLM podría proponer valores que no existen en las fuentes.

**Mitigación:**

* herramientas como fuente de verdad;
* prompt restrictivo;
* separación entre datos y razonamiento;
* clasificación explícita de faltantes;
* confirmación cuando corresponde.

---

### 12.2 Acciones externas accidentales

**Riesgo:** que una instrucción del modelo provoque una acción externa no autorizada.

**Mitigación:**

* no existen integraciones externas;
* confirmación explícita;
* estado de confirmación controlado por backend;
* validación de `listo_para_firma`;
* simulación mediante archivo local.

---

### 12.3 Exposición de secretos

**Riesgo:** exposición de `OPENAI_API_KEY` o credenciales de portales.

**Mitigación:**

* variables de entorno;
* `.env` excluido del repositorio;
* clave únicamente en backend;
* no incluir credenciales en prompts ni logs.

---

### 12.4 Consumo excesivo del LLM

**Riesgo:** ciclos excesivos o consumo inesperado.

**Mitigación:**

```text
MAX_TOOL_ITERATIONS
MAX_SESSION_TOKENS
```

configurables mediante variables de entorno.

---

### 12.5 Soportes vencidos o ausentes

**Riesgo:** generar un paquete aparentemente completo con documentación inválida.

**Mitigación:**

Los soportes son comprobados contra el índice y su vigencia.

Un soporte requerido ausente o vencido impide que:

```text
listo_para_firma = true
```

---

### 12.6 Diferencias entre plantillas

**Riesgo:** cada cliente puede utilizar nombres, estructuras y formatos diferentes.

**Mitigación:**

* glosario de campos;
* maestro centralizado;
* mapeo por etiquetas;
* clasificación de campos no reconocidos;
* confirmación de identificadores ambiguos.

---

### 12.7 Cambios en portales

**Riesgo:** cambios de interfaz, CAPTCHA o MFA pueden romper una automatización.

**Mitigación:**

Mantener al usuario responsable del ingreso de credenciales, MFA, CAPTCHA y acción final de envío.

---

### 12.8 Persistencia basada en archivos

**Riesgo:** `out/` no proporciona las características de una plataforma multiusuario productiva.

**Mitigación para producción:**

* almacenamiento centralizado;
* control de acceso;
* cifrado;
* versionamiento;
* retención;
* auditoría;
* identificación de usuario y sesión.

---

## 13. Conclusión técnica

La implementación cumple el flujo principal solicitado:

```text
Chat
  ↓
Agente
  ↓
Herramientas
  ↓
Lectura y mapeo
  ↓
Generación de formulario
  ↓
Construcción del paquete
  ↓
Validación
  ↓
Confirmación explícita
  ↓
Nueva validación backend
  ↓
Simulación controlada
```

La decisión más importante de diseño es mantener al LLM como **orquestador**, mientras que las herramientas deterministas son responsables de consultar y transformar los datos.

Además, las acciones sensibles no dependen únicamente de las instrucciones del modelo. La confirmación se mantiene en el backend y el estado del paquete se verifica nuevamente antes de crear el resultado de simulación.

La solución queda preparada para una evolución posterior hacia:

* persistencia en base de datos;
* autenticación de usuarios;
* almacenamiento de documentos;
* integración con gestores de secretos;
* integración con portales mediante navegador controlado;
* firma electrónica;
* envío real;
* pruebas automatizadas;
* observabilidad y auditoría centralizada.
