# Agente de registro de proveedores — Reto 01

Aplicación independiente en TypeScript para procesar solicitudes ficticias de registro como proveedor, mapear datos desde el maestro, generar documentos y preparar un paquete para revisión humana.

## Requisitos
- Node.js 20+ (o Bun)
- Una clave de API del proveedor LLM elegido (OpenAI por defecto)

## Instalación y ejecución
```bash
cp .env.example .env
# Completa OPENAI_API_KEY en .env (solo backend)
npm install
npm run dev
```
Abre `http://localhost:3000`.

## Demo sin modelo
```bash
npm run demo
```
Ejecuta las herramientas de los cuatro casos sin necesitar clave del modelo. Los resultados se escriben en `out/`.

## Variables
- `OPENAI_API_KEY`: clave privada del backend.
- `OPENAI_MODEL`: modelo de OpenAI (por defecto `gpt-4o-mini`).
- `PORT`: puerto HTTP (3000 por defecto).
- `MAX_TOOL_ITERATIONS`: máximo de ciclos de herramienta/modelo (máximo efectivo 25).
- `MAX_SESSION_TOKENS`: reservado para límite de tokens por sesión; (30000).

## API
- `POST /api/chat` `{ "sessionId": "...", "message": "..." }` → `{ sessionId, reply, toolCalls, needsConfirmation }`
- `GET /api/sessions/:id` historial de sesión
- `GET /api/health` estado del backend sin exponer secretos

## Casos
`co-industrias-delta` (Excel), `ec-corp-andina` (PDF), `hn-agroexport-sula` (Excel) y `pa-logistica-istmo` (portal, solo valores copiabes).

## Alcance y limitaciones
No firma, no envía correos reales ni interactúa con portales. La confirmación produce únicamente `ENVIO-SIMULADO.md`. Los datos del repositorio son ficticios. Las plantillas Excel se reconstruyen usando las posiciones de celda del JSON porque no se proporcionan libros Excel originales.
