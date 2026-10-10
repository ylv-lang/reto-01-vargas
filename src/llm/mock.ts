import type {
  ChatMessage,
  LlmAdapter,
  LlmResponse,
  ToolSpec
} from './adapter.js';

/**
 * ============================================================
 * MockAdapter
 * ============================================================
 *
 * Adaptador local para probar el ciclo del agente sin utilizar
 * una API externa de LLM.
 *
 * El Mock NO contiene información empresarial de los casos.
 * Los datos se obtienen exclusivamente mediante las herramientas.
 */

export class MockAdapter implements LlmAdapter {

  /**
   * ==========================================================
   * Método principal
   * ==========================================================
   */

  async enviar(
    mensajes: ChatMessage[],
    _herramientas: ToolSpec[]
  ): Promise<LlmResponse> {

    /**
     * Último mensaje enviado por el usuario.
     */
    const ultimoUsuario =
      [...mensajes]
        .reverse()
        .find(
          (mensaje) =>
            mensaje.role === 'user'
        );

    const texto =
      ultimoUsuario?.content
        ?.trim() ?? '';

    /**
     * Herramientas ejecutadas durante el ciclo actual.
     */
    const llamadas =
      this.obtenerHerramientasEjecutadas(
        mensajes
      );

    /**
     * Recuperamos el caso actual.

     * Puede provenir de:
     *
     * 1. El mensaje del usuario.
     * 2. El mensaje de sistema generado por server.ts
     *    para una confirmación pendiente.
     * 3. Los tool_calls del ciclo actual.
     */
    const caso =
      this.obtenerCaso(
        texto,
        mensajes
      );

    /**
     * ========================================================
     * CONFIRMACIÓN EXPLÍCITA
     * ========================================================
     */

    if (
      this.esConfirmacion(
        texto
      )
    ) {

      /**
       * La confirmación no debe ejecutar ninguna acción si
       * no podemos asociarla a un caso pendiente.
       */
      if (!caso) {
        return {
          content:
            'Recibí la confirmación, pero no pude identificar el caso pendiente.',

          toolCalls: []
        };
      }

      return {
        content:
          'Procesaré el envío simulado del caso confirmado.',

        toolCalls: [
          {
            id:
              this.id('envio'),

            name:
              'proveedor_simular_envio',

            arguments:
              JSON.stringify({
                caso,
                confirmado: true
              })
          }
        ]
      };
    }

    /**
     * ========================================================
     * SIN CASO IDENTIFICADO
     * ========================================================
     */

    if (!caso) {
      return {
        content:
          'Indícame el caso de registro que deseas procesar. Por ejemplo: co-industrias-delta.',

        toolCalls: []
      };
    }

    /**
     * ========================================================
     * FLUJO NORMAL
     * ========================================================
     *
     * 1. Leer solicitud.
     * 2. Mapear campos.
     * 3. Generar formulario.
     * 4. Armar paquete.
     * 5. Solicitar confirmación.
     */

    /**
     * --------------------------------------------------------
     * 1. Leer solicitud
     * --------------------------------------------------------
     */

    if (
      !this.seEjecuto(
        llamadas,
        'proveedor_leer_solicitud'
      )
    ) {
      return {
        content: null,

        toolCalls: [
          {
            id:
              this.id('leer'),

            name:
              'proveedor_leer_solicitud',

            arguments:
              JSON.stringify({
                caso
              })
          }
        ]
      };
    }

    /**
     * --------------------------------------------------------
     * 2. Mapear campos
     * --------------------------------------------------------
     */

    if (
      !this.seEjecuto(
        llamadas,
        'proveedor_mapear_campos'
      )
    ) {
      return {
        content: null,

        toolCalls: [
          {
            id:
              this.id('mapear'),

            name:
              'proveedor_mapear_campos',

            arguments:
              JSON.stringify({
                caso
              })
          }
        ]
      };
    }

    /**
     * --------------------------------------------------------
     * 3. Generar formulario
     * --------------------------------------------------------
     *
     * No enviamos:
     *
     *     mapeo: {}
     *
     * porque el objeto vacío podría interpretarse como un
     * mapeo proporcionado por el agente.
     *
     * Si se omite, proveedor_generar_formulario calcula
     * el mapeo internamente.
     */

    if (
      !this.seEjecuto(
        llamadas,
        'proveedor_generar_formulario'
      )
    ) {
      return {
        content: null,

        toolCalls: [
          {
            id:
              this.id('formulario'),

            name:
              'proveedor_generar_formulario',

            arguments:
              JSON.stringify({
                caso
              })
          }
        ]
      };
    }

    /**
     * --------------------------------------------------------
     * 4. Armar paquete
     * --------------------------------------------------------
     */

    if (
      !this.seEjecuto(
        llamadas,
        'proveedor_armar_paquete'
      )
    ) {
      return {
        content: null,

        toolCalls: [
          {
            id:
              this.id('paquete'),

            name:
              'proveedor_armar_paquete',

            arguments:
              JSON.stringify({
                caso
              })
          }
        ]
      };
    }

    /**
     * ========================================================
     * RESPUESTA FINAL
     * ========================================================
     *
     * No ejecutamos todavía el envío.
     *
     * Primero se requiere confirmación.
     */

    return {
      content: [
        `El caso ${caso} fue procesado.`,
        '',
        'Se revisaron la solicitud, los campos, el formulario y el paquete de soportes.',
        '',
        'El paquete queda pendiente de confirmación antes de simular el envío.',
        '',
        'Si deseas continuar, responde explícitamente: "Sí, confirmo el envío".'
      ].join('\n'),

      toolCalls: []
    };
  }

  /**
   * ==========================================================
   * Detectar confirmación explícita
   * ==========================================================
   */

  private esConfirmacion(
    texto: string
  ): boolean {

    const normalizado =
      texto
        .toLowerCase()
        .trim();

    return /^(sí|si|confirmo|confirmado|confirmada|adelante|procede|proceder|ok|de acuerdo)([\s,!.;:]|$)/i.test(
      normalizado
    );
  }

  /**
   * ==========================================================
   * Obtener caso
   * ==========================================================
   *
   * Orden de búsqueda:
   *
   * 1. Mensaje actual del usuario.
   * 2. Mensaje de sistema de confirmación pendiente.
   * 3. Tool calls del ciclo actual.
   */

  private obtenerCaso(
    texto: string,
    mensajes: ChatMessage[]
  ): string | null {

    /**
     * --------------------------------------------------------
     * 1. Buscar caso en el mensaje actual
     * --------------------------------------------------------
     */

    const match =
      texto.match(
        /\b(co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo)\b/i
      );

    if (match?.[1]) {
      return match[1].toLowerCase();
    }

    /**
     * --------------------------------------------------------
     * 2. Buscar caso en mensajes de sistema
     * --------------------------------------------------------
     *
     * server.ts agrega un mensaje similar a:
     *
     * "Existe una confirmación válida para el caso
     *  ec-corp-andina..."
     *
     * Esto permite que una confirmación como:
     *
     * "Sí, confirmo el envío"
     *
     * pueda asociarse al caso correcto.
     */

    for (
      const mensaje of mensajes
    ) {

      if (
        mensaje.role !== 'system'
      ) {
        continue;
      }

      const matchSistema =
        mensaje.content.match(
          /\b(co-industrias-delta|ec-corp-andina|hn-agroexport-sula|pa-logistica-istmo)\b/i
        );

      if (
        matchSistema?.[1]
      ) {
        return matchSistema[1]
          .toLowerCase();
      }
    }

    /**
     * --------------------------------------------------------
     * 3. Buscar caso en tool_calls
     * --------------------------------------------------------
     *
     * Esto funciona durante el mismo ciclo de ejecución.
     */

    for (
      const mensaje of mensajes
    ) {

      const mensajeExtendido =
        mensaje as ChatMessage & {
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };

      if (
        !mensajeExtendido.tool_calls
      ) {
        continue;
      }

      for (
        const toolCall of
          mensajeExtendido.tool_calls
      ) {

        const argumentos =
          toolCall.function
            ?.arguments;

        if (!argumentos) {
          continue;
        }

        try {
          const parsed =
            JSON.parse(
              argumentos
            );

          if (
            typeof parsed.caso ===
              'string' &&
            /^[a-z0-9-]+$/.test(
              parsed.caso
            )
          ) {
            return parsed.caso;
          }
        } catch {
          /**
           * Si los argumentos no son JSON válido,
           * seguimos buscando.
           */
        }
      }
    }

    return null;
  }

  /**
   * ==========================================================
   * Verificar si una herramienta ya fue ejecutada
   * ==========================================================
   */

  private seEjecuto(
    llamadas: string[],
    nombre: string
  ): boolean {

    return llamadas.some(
      (llamada) =>
        llamada === nombre
    );
  }

  /**
   * ==========================================================
   * Obtener herramientas ejecutadas
   * ==========================================================
   */

  private obtenerHerramientasEjecutadas(
    mensajes: ChatMessage[]
  ): string[] {

    return mensajes
      .filter(
        (mensaje) =>
          mensaje.role === 'tool'
      )
      .map(
        (mensaje) =>
          mensaje.name ?? ''
      )
      .filter(
        Boolean
      );
  }

  /**
   * ==========================================================
   * Generar ID para tool call
   * ==========================================================
   */

  private id(
    prefijo: string
  ): string {

    return [
      'mock',
      prefijo,
      Date.now(),
      Math.random()
        .toString(36)
        .slice(2, 8)
    ].join('-');
  }
}