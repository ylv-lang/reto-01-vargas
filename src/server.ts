import 'dotenv/config';

import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { OpenAiAdapter } from './llm/openai.js';
import { MockAdapter } from './llm/mock.js';

import type {
  LlmAdapter
} from './llm/adapter.js';

import {
  tools
} from './tools/proveedor.js';

type SessionMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type PendingConfirmation = {
  caso: string;
};

type ToolCallResult = {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
};

const app = express();

app.use(
  express.json({
    limit: '1mb'
  })
);

app.use(
  express.static(
    path.resolve('web')
  )
);

const sessions =
  new Map<string, SessionMessage[]>();

const pendingConfirmations =
  new Map<string, PendingConfirmation>();

const directory =
  process.cwd();

const toolList =
  Object.entries(tools);

/**
 * Obtiene el proveedor LLM configurado.
 */
function getLlmProvider(): string {
  return (
    process.env.LLM_PROVIDER ??
    'openai'
  ).toLowerCase();
}

/**
 * Crea el adaptador LLM.
 */
function createLlmAdapter(): LlmAdapter {
  const provider =
    getLlmProvider();

  if (provider === 'mock') {
    console.log(
      'LLM_PROVIDER=mock → usando MockAdapter local'
    );

    return new MockAdapter();
  }

  if (provider === 'openai') {
    return new OpenAiAdapter();
  }

  throw new Error(
    `Proveedor LLM no soportado: ${provider}. Usa "mock" u "openai".`
  );
}

/**
 * Esquemas de argumentos de las herramientas.
 */
const schemas: Record<string, any> = {
  proveedor_leer_solicitud: {
    type: 'object',

    properties: {
      caso: {
        type: 'string',
        description:
          'Identificador del caso a procesar.'
      }
    },

    required: [
      'caso'
    ],

    additionalProperties: false
  },

  proveedor_mapear_campos: {
    type: 'object',

    properties: {
      caso: {
        type: 'string',
        description:
          'Identificador del caso.'
      },

      campos: {
        type: 'array',

        items: {
          type: 'string'
        },

        description:
          'Lista opcional de campos a mapear.'
      }
    },

    required: [
      'caso'
    ],

    additionalProperties: false
  },

  proveedor_generar_formulario: {
    type: 'object',

    properties: {
      caso: {
        type: 'string',
        description:
          'Identificador del caso.'
      },

      mapeo: {
        type: 'object',

        description:
          'Mapeo opcional de campos.'
      }
    },

    required: [
      'caso'
    ],

    additionalProperties: false
  },

  proveedor_armar_paquete: {
    type: 'object',

    properties: {
      caso: {
        type: 'string',
        description:
          'Identificador del caso.'
      }
    },

    required: [
      'caso'
    ],

    additionalProperties: false
  },

  proveedor_simular_envio: {
    type: 'object',

    properties: {
      caso: {
        type: 'string',
        description:
          'Identificador del caso.'
      },

      confirmado: {
        type: 'boolean',

        description:
          'Debe ser true únicamente después de una confirmación explícita.'
      }
    },

    required: [
      'caso',
      'confirmado'
    ],

    additionalProperties: false
  }
};

/**
 * Convierte las herramientas internas
 * al formato esperado por el LLM.
 */
const llmTools =
  toolList.map(
    ([name, tool]) => ({
      type: 'function' as const,

      function: {
        name,

        description:
          tool.description,

        parameters:
          schemas[name]
      }
    })
  );

/**
 * Detecta una confirmación explícita.
 *
 * Ejemplos válidos:
 *
 * Sí
 * Si
 * Sí, confirmo
 * Sí, confirmo el envío
 * Confirmo
 * Confirmado
 * Adelante
 * Procede
 * OK
 * De acuerdo
 */
function esConfirmacionExplicita(
  mensaje: string
): boolean {
  const normalizado =
    mensaje
      .toLowerCase()
      .trim();

  return /^(sí|si|confirmo|confirmado|confirmada|adelante|procede|proceder|ok|de acuerdo)([\s,!.;:]|$)/i.test(
    normalizado
  );
}

/**
 * Ejecuta una herramienta.
 */
async function ejecutarHerramienta(
  nombre: string,
  argumentos: Record<string, unknown>,
  sessionId: string,
  envioConfirmado: boolean
): Promise<{
  result: unknown;
  raw: string;
}> {
  const tool =
    (tools as any)[nombre];

  if (!tool) {
    const raw =
      JSON.stringify({
        ok: false,

        error:
          `Herramienta desconocida: ${nombre}`
      });

    return {
      result:
        JSON.parse(raw),

      raw
    };
  }

  const parsed =
    tool.args.parse(
      argumentos
    );

  const raw =
    await tool.execute(
      parsed,
      {
        directory,
        sessionId,
        envioConfirmado
      }
    );

  return {
    result:
      JSON.parse(raw),

    raw
  };
}

/**
 * Health check.
 */
app.get(
  '/api/health',
  (_req, res) => {
    res.json({
      ok: true,

      provider:
        getLlmProvider(),

      model:
        process.env.OPENAI_MODEL ??
        'gpt-4o-mini'
    });
  }
);

/**
 * Recupera el historial de una sesión.
 */
app.get(
  '/api/sessions/:id',
  (req, res) => {
    const id =
      req.params.id;

    res.json({
      sessionId: id,

      messages:
        sessions.get(id) ?? []
    });
  }
);

/**
 * Endpoint principal del agente.
 */
app.post(
  '/api/chat',
  async (req, res) => {
    const message =
      String(
        req.body?.message ?? ''
      ).trim();

    const sessionId =
      String(
        req.body?.sessionId ??
          crypto.randomUUID()
      );

    if (!message) {
      return res.status(400).json({
        error:
          'El mensaje está vacío'
      });
    }

    const history =
      sessions.get(sessionId) ?? [];

    const calls:
      ToolCallResult[] = [];

    let reply = '';

    try {
      /**
       * =========================================================
       * 1. COMPROBAR SI EXISTE UNA CONFIRMACIÓN PENDIENTE
       * =========================================================
       */

      const pending =
        pendingConfirmations.get(
          sessionId
        );

      const userConfirmed =
        Boolean(
          pending &&
          esConfirmacionExplicita(
            message
          )
        );

      /**
       * =========================================================
       * 2. FLUJO DETERMINÍSTICO DE CONFIRMACIÓN
       *
       * Si existe un caso pendiente y el usuario confirma,
       * el backend ya conoce el caso.
       *
       * No dependemos del LLM para recuperar el caso.
       * =========================================================
       */

      if (
        pending &&
        userConfirmed
      ) {
        const caso =
          pending.caso;

        console.log(
          `[CONFIRMACION] Sesión ${sessionId}: confirmación válida para ${caso}`
        );

        const argumentos: Record<
          string,
          unknown
        > = {
          caso,
          confirmado: true
        };

        const execution =
          await ejecutarHerramienta(
            'proveedor_simular_envio',
            argumentos,
            sessionId,
            true
          );

        calls.push({
          name:
            'proveedor_simular_envio',

          arguments:
            argumentos,

          result:
            execution.result
        });

        const result =
          execution.result as any;

        /**
         * La herramienta actualmente utiliza
         * envio_realizado=false para indicar
         * que solamente se generó la simulación.
         */
        if (
          result?.ok &&
          result?.data?.envio_realizado === false
        ) {
          reply = [
            `La confirmación fue recibida para el caso ${caso}.`,
            '',
            'Se ejecutó la simulación del envío.',
            '',
            'No se realizó ningún envío externo real.'
          ].join('\n');
        } else if (
          result?.ok
        ) {
          reply = [
            `La confirmación fue recibida para el caso ${caso}.`,
            '',
            'La operación solicitada fue procesada correctamente.'
          ].join('\n');
        } else {
          reply = [
            `La confirmación fue recibida para el caso ${caso}.`,
            '',
            'La simulación no pudo ejecutarse porque existen validaciones pendientes.',
            '',
            'Revisa el resultado de la herramienta.'
          ].join('\n');
        }

        /**
         * La confirmación ya fue consumida.
         */
        pendingConfirmations.delete(
          sessionId
        );

        history.push({
          role: 'user',
          content: message
        });

        history.push({
          role: 'assistant',
          content: reply
        });

        sessions.set(
          sessionId,
          history
        );

        return res.json({
          sessionId,

          reply,

          toolCalls:
            calls,

          needsConfirmation:
            false
        });
      }

      /**
       * =========================================================
       * 3. CONFIRMACIÓN SIN CASO PENDIENTE
       * =========================================================
       */

      if (
        esConfirmacionExplicita(
          message
        ) &&
        !pending
      ) {
        reply = [
          'Recibí una confirmación, pero no existe una operación pendiente de confirmación.',
          '',
          'Primero indica qué caso deseas procesar.'
        ].join('\n');

        history.push({
          role: 'user',
          content: message
        });

        history.push({
          role: 'assistant',
          content: reply
        });

        sessions.set(
          sessionId,
          history
        );

        return res.json({
          sessionId,

          reply,

          toolCalls: [],

          needsConfirmation:
            false
        });
      }

      /**
       * =========================================================
       * 4. FLUJO NORMAL DEL AGENTE
       * =========================================================
       */

      history.push({
        role: 'user',
        content: message
      });

      const adapter =
        createLlmAdapter();

      const prompt =
        await fs.readFile(
          path.resolve(
            'agent/prompt.md'
          ),
          'utf8'
        );

      const msgs: any[] = [
        {
          role: 'system',
          content: prompt
        },

        ...history
      ];

      const limit =
        Math.max(
          1,

          Math.min(
            25,

            Number(
              process.env
                .MAX_TOOL_ITERATIONS ??
                25
            )
          )
        );

      for (
        let i = 0;
        i < limit;
        i++
      ) {
        const answer =
          await adapter.enviar(
            msgs,
            llmTools
          );

        /**
         * Si no hay llamadas a herramientas,
         * tenemos la respuesta final del agente.
         */
        if (
          !answer.toolCalls.length
        ) {
          reply =
            answer.content ??
            'No se obtuvo una respuesta.';

          break;
        }

        /**
         * Agregar la respuesta del asistente
         * al contexto interno del ciclo.
         */
        msgs.push({
          role: 'assistant',

          content:
            answer.content ?? '',

          tool_calls:
            answer.toolCalls.map(
              (call) => ({
                id:
                  call.id,

                type:
                  'function',

                function: {
                  name:
                    call.name,

                  arguments:
                    call.arguments
                }
              })
            )
        });

        /**
         * Ejecutar las herramientas solicitadas.
         */
        for (
          const call
          of answer.toolCalls
        ) {
          const tool =
            (tools as any)[
              call.name
            ];

          if (!tool) {
            const raw =
              JSON.stringify({
                ok: false,

                error:
                  'Herramienta desconocida'
              });

            calls.push({
              name:
                call.name,

              arguments: {},

              result:
                JSON.parse(raw)
            });

            msgs.push({
              role: 'tool',

              tool_call_id:
                call.id,

              content:
                raw
            });

            continue;
          }

          /**
           * IMPORTANTE:
           *
           * Inicializamos args con {}
           * para evitar:
           *
           * TS2454:
           * Variable 'args' is used before being assigned.
           */
          let args:
            Record<
              string,
              unknown
            > = {};

          try {
            args =
              JSON.parse(
                call.arguments
              );

            const execution =
              await ejecutarHerramienta(
                call.name,
                args,
                sessionId,
                false
              );

            calls.push({
              name:
                call.name,

              arguments:
                args,

              result:
                execution.result
            });

            msgs.push({
              role: 'tool',

              tool_call_id:
                call.id,

              name:
                call.name,

              content:
                execution.raw
            });
          } catch (error) {
            const raw =
              JSON.stringify({
                ok: false,

                error:
                  error instanceof Error
                    ? error.message
                    : 'Argumentos inválidos'
              });

            calls.push({
              name:
                call.name,

              arguments:
                args,

              result:
                JSON.parse(raw)
            });

            msgs.push({
              role: 'tool',

              tool_call_id:
                call.id,

              content:
                raw
            });
          }
        }
      }

      /**
       * Si se alcanzó el límite de iteraciones.
       */
      if (!reply) {
        reply =
          'Alcancé el límite de iteraciones. Revisa las llamadas a herramientas y continúa con una nueva instrucción.';
      }

      /**
       * =========================================================
       * 5. REGISTRAR EL CASO COMO PENDIENTE
       * =========================================================
       *
       * Buscamos la última ejecución de:
       *
       * proveedor_armar_paquete
       *
       * y almacenamos el caso en memoria de sesión.
       */

      const ultimoPaquete =
        [...calls]
          .reverse()
          .find(
            (call) =>
              call.name ===
              'proveedor_armar_paquete'
          );

      if (
        ultimoPaquete &&
        typeof ultimoPaquete
          .arguments
          ?.caso === 'string'
      ) {
        /**
         * Si la respuesta solicita confirmación,
         * almacenamos el caso.
         */
        if (
          /confirm/i.test(
            reply
          ) ||
          /¿.*env[ií]o/i.test(
            reply
          ) ||
          /¿.*proced/i.test(
            reply
          )
        ) {
          const caso =
            String(
              ultimoPaquete
                .arguments
                .caso
            );

          pendingConfirmations.set(
            sessionId,
            {
              caso
            }
          );

          console.log(
            `[PENDIENTE] Sesión ${sessionId} → caso ${caso}`
          );
        }
      }

      /**
       * Guardar respuesta final.
       */
      history.push({
        role: 'assistant',
        content: reply
      });

      sessions.set(
        sessionId,
        history
      );

      return res.json({
        sessionId,

        reply,

        toolCalls:
          calls,

        needsConfirmation:
          pendingConfirmations.has(
            sessionId
          )
      });
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Error inesperado';

      console.error(
        '[ERROR /api/chat]',
        error
      );

      return res.status(200).json({
        sessionId,

        reply:
          `No pude completar la solicitud: ${msg}`,

        toolCalls:
          calls,

        needsConfirmation:
          false
      });
    }
  }
);

/**
 * Inicio del servidor.
 */
const port =
  Number(
    process.env.PORT ?? 3000
  );

app.listen(
  port,
  () => {
    console.log(
      `Servidor iniciado en puerto ${port}`
    );

    console.log(
      `Proveedor LLM: ${getLlmProvider()}`
    );
  }
);