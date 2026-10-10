import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * ============================================================
 * Esquemas de entrada
 * ============================================================
 */

const CasoArgs = z.object({
  caso: z
    .string()
    .describe('Nombre exacto de la carpeta del caso')
});

const MapeoArgs = z.object({
  caso: z
    .string()
    .describe('Nombre exacto de la carpeta del caso'),

  campos: z
    .array(z.string())
    .optional()
    .describe('Etiquetas solicitadas; opcional')
});

/**
 * Resultado estructurado del mapeo.
 *
 * Este esquema representa solamente el contenido de "data"
 * devuelto por proveedor_mapear_campos.
 */
const MapeoResultado = z.object({
  llenos: z.array(
    z.object({
      etiqueta: z.string(),
      clave_maestro: z.string(),
      valor: z.unknown()
    })
  ),

  faltantes: z.array(
    z.object({
      etiqueta: z.string(),
      clave_maestro: z.string().optional(),
      razon: z.string()
    })
  ),

  requiere_confirmacion: z.array(
    z.object({
      etiqueta: z.string(),
      clave_maestro: z.string(),
      valor: z.unknown(),
      nota: z.string().optional(),
      propuesta: z.string().optional()
    })
  )
});

const GenerarArgs = z.object({
  caso: z
    .string()
    .describe('Nombre exacto de la carpeta del caso'),

  mapeo: MapeoResultado
    .optional()
    .describe(
      'Resultado estructurado de proveedor_mapear_campos; si se omite se calcula automáticamente'
    )
});

const EnvioArgs = z.object({
  caso: z
    .string()
    .describe('Nombre exacto de la carpeta del caso'),

  confirmado: z
    .boolean()
    .describe(
      'Confirmación explícita recibida del usuario en el turno inmediatamente anterior'
    )
});

/**
 * ============================================================
 * Contexto de ejecución
 * ============================================================
 */

export type ToolContext = {
  directory: string;
  sessionId: string;

  /**
   * El servidor establece esta propiedad únicamente cuando
   * la confirmación fue validada en el backend.
   */
  envioConfirmado?: boolean;
};

/**
 * ============================================================
 * Funciones auxiliares
 * ============================================================
 */

const ok = (data: unknown) =>
  JSON.stringify({
    ok: true,
    data
  });

const fail = (error: string) =>
  JSON.stringify({
    ok: false,
    error
  });

const root = (ctx: ToolContext) =>
  path.resolve(
    ctx.directory,
    'fixtures',
    'reto-01'
  );

const caseDir = (
  ctx: ToolContext,
  caso: string
) => {
  /**
   * El nombre del caso está restringido para evitar
   * traversal de rutas.
   */
  if (!/^[a-z0-9-]+$/.test(caso)) {
    throw new Error(
      'Nombre de caso inválido'
    );
  }

  return path.join(
    root(ctx),
    'casos',
    caso
  );
};

async function json<T>(
  file: string
): Promise<T> {
  return JSON.parse(
    await fs.readFile(
      file,
      'utf8'
    )
  ) as T;
}

async function log(
  ctx: ToolContext,
  caso: string,
  tool: string,
  success: boolean,
  resumen: string
) {
  const dir = path.resolve(
    ctx.directory,
    'out',
    caso
  );

  await fs.mkdir(
    dir,
    {
      recursive: true
    }
  );

  await fs.appendFile(
    path.join(
      dir,
      'log.jsonl'
    ),
    JSON.stringify({
      ts: new Date().toISOString(),
      herramienta: tool,
      ok: success,
      resumen
    }) + '\n'
  );
}

function getPath(
  obj: Record<string, any>,
  key: string
): unknown {
  return key
    .split('.')
    .reduce(
      (value, part) =>
        value == null
          ? undefined
          : value[part],
      obj as any
    );
}

/**
 * ============================================================
 * Generación de PDF
 * ============================================================
 */

async function writePdf(
  file: string,
  rows: any[]
) {
  await fs.mkdir(
    path.dirname(file),
    {
      recursive: true
    }
  );

  await new Promise<void>(
    (resolve, reject) => {
      const doc =
        new PDFDocument({
          margin: 50
        });

      const stream =
        createWriteStream(file);

      stream.on(
        'finish',
        resolve
      );

      stream.on(
        'error',
        reject
      );

      doc.pipe(stream);

      doc
        .fontSize(18)
        .text(
          'Formulario de registro de proveedor',
          {
            underline: true
          }
        );

      doc.moveDown();

      rows.forEach(
        (row) => {
          doc
            .fontSize(10)
            .fillColor('#333')
            .text(
              row.etiqueta
            );

          doc
            .fontSize(12)
            .fillColor('#000')
            .text(
              row.valor === undefined
                ? '[FALTANTE]'
                : String(row.valor)
            );

          doc.moveDown(0.6);
        }
      );

      doc.end();
    }
  );
}

/**
 * ============================================================
 * Tool: proveedor_leer_solicitud
 * ============================================================
 */

export const proveedor_leer_solicitud = {
  description:
    'Lee el correo normalizado, plantilla y soportes exigidos de un caso de registro.',

  args: CasoArgs,

  async execute(
    args: z.infer<typeof CasoArgs>,
    ctx: ToolContext
  ) {
    try {
      const dir =
        caseDir(
          ctx,
          args.caso
        );

      const solicitud =
        await json<any>(
          path.join(
            dir,
            'solicitud.json'
          )
        );

      let campos: any[] = [];

      if (
        solicitud.formato ===
        'xlsx'
      ) {
        campos =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-celdas.json'
            )
          );
      } else if (
        solicitud.formato ===
        'pdf'
      ) {
        campos =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-campos.json'
            )
          );
      }

      const soportes =
        await json<string[]>(
          path.join(
            dir,
            'soportes-exigidos.json'
          )
        );

      const data = {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        campos: campos.map(
          (campo) =>
            campo.etiqueta
        ),
        soportes,
        solicitud
      };

      await log(
        ctx,
        args.caso,
        'proveedor_leer_solicitud',
        true,
        `${campos.length} campos; formato ${solicitud.formato}`
      );

      return ok(data);
    } catch (e) {
      return fail(
        e instanceof Error
          ? e.message
          : 'No se pudo leer la solicitud'
      );
    }
  }
};

/**
 * ============================================================
 * Tool: proveedor_mapear_campos
 * ============================================================
 */

export const proveedor_mapear_campos = {
  description:
    'Cruza las etiquetas solicitadas con el glosario y el repositorio maestro sin inventar valores.',

  args: MapeoArgs,

  async execute(
    args: z.infer<typeof MapeoArgs>,
    ctx: ToolContext
  ) {
    try {
      const dir =
        caseDir(
          ctx,
          args.caso
        );

      const solicitud =
        await json<any>(
          path.join(
            dir,
            'solicitud.json'
          )
        );

      let campos: any[];

      if (
        solicitud.formato ===
        'xlsx'
      ) {
        campos =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-celdas.json'
            )
          );
      } else {
        campos =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-campos.json'
            )
          );
      }

      const glosario =
        await json<Record<string, string>>(
          path.join(
            root(ctx),
            'glosario-campos.json'
          )
        );

      const maestro =
        await json<Record<string, any>>(
          path.join(
            root(ctx),
            'repositorio',
            'maestro.json'
          )
        );

      const etiquetas =
        args.campos?.length
          ? args.campos
          : campos.map(
              (campo) =>
                campo.etiqueta
            );

      const llenos: any[] = [];
      const faltantes: any[] = [];
      const requiere_confirmacion: any[] = [];

      for (
        const etiqueta of etiquetas
      ) {
        const key =
          glosario[etiqueta];

        if (!key) {
          faltantes.push({
            etiqueta,
            razon:
              'Etiqueta no encontrada en glosario'
          });

          continue;
        }

        const value =
          getPath(
            maestro,
            key
          );

        if (
          value === undefined ||
          value === null ||
          value === ''
        ) {
          faltantes.push({
            etiqueta,
            clave_maestro: key,
            razon:
              'Dato no disponible'
          });

          continue;
        }

        const item = {
          etiqueta,
          clave_maestro: key,
          valor: value
        };

        /**
         * Para casos diferentes de Colombia,
         * el maestro solamente contiene NIT colombiano.
         * Por eso el dato requiere revisión.
         */
        if (
          key === 'nit' &&
          solicitud.pais !== 'CO'
        ) {
          requiere_confirmacion.push({
            ...item,
            nota:
              'identificador extranjero',
            propuesta:
              'El maestro solo contiene NIT colombiano'
          });
        } else {
          llenos.push(item);
        }
      }

      const data = {
        llenos,
        faltantes,
        requiere_confirmacion
      };

      await log(
        ctx,
        args.caso,
        'proveedor_mapear_campos',
        true,
        `${llenos.length} llenos; ${faltantes.length} faltantes; ${requiere_confirmacion.length} por confirmar`
      );

      return ok(data);
    } catch (e) {
      return fail(
        e instanceof Error
          ? e.message
          : 'No se pudieron mapear los campos'
      );
    }
  }
};

/**
 * ============================================================
 * Tool: proveedor_generar_formulario
 * ============================================================
 */

export const proveedor_generar_formulario = {
  description:
    'Genera el formulario en Excel, PDF o un archivo Markdown copiable para portal.',

  args: GenerarArgs,

  async execute(
    args: z.infer<typeof GenerarArgs>,
    ctx: ToolContext
  ) {
    try {
      const dir =
        caseDir(
          ctx,
          args.caso
        );

      const solicitud =
        await json<any>(
          path.join(
            dir,
            'solicitud.json'
          )
        );

      /**
       * Si el LLM no entrega un mapeo,
       * la herramienta lo calcula directamente.
       *
       * Si el LLM entrega un mapeo,
       * lo normalizamos al mismo formato interno.
       */
      let mapped: {
        ok: boolean;
        data?: z.infer<
          typeof MapeoResultado
        >;
        error?: string;
      };

      if (args.mapeo) {
        mapped = {
          ok: true,
          data: args.mapeo
        };
      } else {
        mapped =
          JSON.parse(
            await proveedor_mapear_campos.execute(
              {
                caso: args.caso
              },
              ctx
            )
          );
      }

      if (!mapped.ok) {
        return fail(
          mapped.error ??
            'No se pudo obtener el mapeo'
        );
      }

      if (!mapped.data) {
        return fail(
          'El resultado del mapeo está vacío'
        );
      }

      const all = [
        ...mapped.data.llenos,
        ...mapped.data.requiere_confirmacion
      ];

      const valueByLabel =
        new Map(
          all.map(
            (item) => [
              item.etiqueta,
              item.valor
            ]
          )
        );

      const out =
        path.resolve(
          ctx.directory,
          'out',
          args.caso
        );

      await fs.mkdir(
        out,
        {
          recursive: true
        }
      );

      /**
       * --------------------------------------------------------
       * Excel
       * --------------------------------------------------------
       */

      if (
        solicitud.formato ===
        'xlsx'
      ) {
        const template =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-celdas.json'
            )
          );

        const wb =
          new ExcelJS.Workbook();

        const bySheet =
          new Map<
            string,
            any[]
          >();

        for (
          const row of template
        ) {
          if (
            !bySheet.has(
              row.hoja
            )
          ) {
            bySheet.set(
              row.hoja,
              []
            );
          }

          bySheet
            .get(row.hoja)!
            .push(row);
        }

        for (
          const [
            sheetName,
            rows
          ] of bySheet
        ) {
          const ws =
            wb.addWorksheet(
              sheetName
            );

          for (
            const row of rows
          ) {
            ws
              .getCell(
                row.celda_etiqueta
              )
              .value =
              row.etiqueta;

            const value =
              valueByLabel.get(
                row.etiqueta
              );

            ws
              .getCell(
                row.celda_valor
              )
              .value =
              value === undefined
                ? ''
                : String(value);
          }
        }

        const dest =
          path.join(
            out,
            'formulario.xlsx'
          );

        await wb.xlsx.writeFile(
          dest
        );

        await log(
          ctx,
          args.caso,
          'proveedor_generar_formulario',
          true,
          'Excel generado'
        );

        return ok({
          ruta: dest,
          formato: 'xlsx'
        });
      }

      /**
       * --------------------------------------------------------
       * PDF
       * --------------------------------------------------------
       */

      if (
        solicitud.formato ===
        'pdf'
      ) {
        const template =
          await json<any[]>(
            path.join(
              dir,
              'plantilla-campos.json'
            )
          );

        const dest =
          path.join(
            out,
            'formulario.pdf'
          );

        await writePdf(
          dest,
          template.map(
            (row) => ({
              etiqueta:
                row.etiqueta,
              valor:
                valueByLabel.get(
                  row.etiqueta
                )
            })
          )
        );

        await log(
          ctx,
          args.caso,
          'proveedor_generar_formulario',
          true,
          'PDF generado'
        );

        return ok({
          ruta: dest,
          formato: 'pdf'
        });
      }

      /**
       * --------------------------------------------------------
       * Portal web
       * --------------------------------------------------------
       */

      const template =
        await json<any[]>(
          path.join(
            dir,
            'plantilla-campos.json'
          )
        ).catch(
          () => []
        );

      const dest =
        path.join(
          out,
          'valores-portal.md'
        );

      const lines = [
        '# Valores para portal web',
        '',
        '> El llenado real del portal no está implementado.',
        ''
      ];

      for (
        const row of template
      ) {
        const value =
          valueByLabel.get(
            row.etiqueta
          );

        lines.push(
          `- **${row.etiqueta}:** ${
            value === undefined
              ? '[FALTANTE]'
              : String(value)
          }`
        );
      }

      await fs.writeFile(
        dest,
        lines.join('\n')
      );

      await log(
        ctx,
        args.caso,
        'proveedor_generar_formulario',
        true,
        'Valores de portal preparados'
      );

      return ok({
        ruta: dest,
        formato: 'portal'
      });
    } catch (e) {
      return fail(
        e instanceof Error
          ? e.message
          : 'No se pudo generar el formulario'
      );
    }
  }
};

/**
 * ============================================================
 * Tool: proveedor_armar_paquete
 * ============================================================
 */

export const proveedor_armar_paquete = {
  description:
    'Copia soportes exigidos y crea checklist y borrador de correo para revisión.',

  args: CasoArgs,

  async execute(
    args: z.infer<typeof CasoArgs>,
    ctx: ToolContext
  ) {
    try {
      const dir =
        caseDir(
          ctx,
          args.caso
        );

      const solicitud =
        await json<any>(
          path.join(
            dir,
            'solicitud.json'
          )
        );

      const required =
        await json<string[]>(
          path.join(
            dir,
            'soportes-exigidos.json'
          )
        );

      /**
       * --------------------------------------------------------
       * Validación de datos empresariales
       * --------------------------------------------------------
       *
       * El paquete no puede quedar listo para firma si existen
       * datos faltantes o campos pendientes de confirmación.
       */

      const mappingRaw =
        await proveedor_mapear_campos.execute(
          {
            caso: args.caso
          },
          ctx
        );

      const mappingResult =
        JSON.parse(mappingRaw);

      if (!mappingResult.ok) {
        return fail(
          mappingResult.error ??
            'No se pudo validar el mapeo de campos'
        );
      }

      const mappingData =
        mappingResult.data;

      const camposFaltantes =
        mappingData.faltantes ??
        [];

      const camposPorConfirmar =
        mappingData.requiere_confirmacion ??
        [];

      /**
       * --------------------------------------------------------
       * Preparación del directorio
       * --------------------------------------------------------
       */

      const index =
        await json<any[]>(
          path.join(
            root(ctx),
            'repositorio',
            'soportes',
            'index.json'
          )
        );

      const dest =
        path.resolve(
          ctx.directory,
          'out',
          args.caso,
          'paquete'
        );

      await fs.mkdir(
        dest,
        {
          recursive: true
        }
      );

      const now =
        new Date()
          .toISOString()
          .slice(0, 10);

      const checklist: string[] = [];

      let blocked = false;

      /**
       * --------------------------------------------------------
       * Validación y copia de soportes
       * --------------------------------------------------------
       */

      for (
        const tipo of required
      ) {
        const item =
          index.find(
            (entry) =>
              entry.tipo === tipo
          );

        if (!item) {
          checklist.push(
            `- [ ] ${tipo}: **ausente**`
          );

          blocked = true;

          continue;
        }

        const expired =
          Boolean(
            item.vigencia_hasta &&
              item.vigencia_hasta <
                now
          );

        const src =
          path.join(
            root(ctx),
            'repositorio',
            'soportes',
            item.archivo
          );

        try {
          await fs.copyFile(
            src,
            path.join(
              dest,
              item.archivo
            )
          );

          checklist.push(
            `- [${
              expired
                ? ' '
                : 'x'
            }] ${tipo}: ${
              expired
                ? '**vencido**'
                : 'presente'
            }${
              item.vigencia_hasta
                ? ` (vigencia hasta ${item.vigencia_hasta})`
                : ''
            }`
          );

          if (expired) {
            blocked = true;
          }
        } catch {
          checklist.push(
            `- [ ] ${tipo}: **ausente**`
          );

          blocked = true;
        }
      }

      /**
       * --------------------------------------------------------
       * Verificación del formulario generado
       * --------------------------------------------------------
       */

      const formPath =
        path.resolve(
          ctx.directory,
          'out',
          args.caso,
          solicitud.formato ===
            'xlsx'
            ? 'formulario.xlsx'
            : solicitud.formato ===
              'pdf'
              ? 'formulario.pdf'
              : 'valores-portal.md'
        );

      let formularioDisponible =
        true;

      try {
        await fs.copyFile(
          formPath,
          path.join(
            dest,
            path.basename(
              formPath
            )
          )
        );
      } catch {
        formularioDisponible =
          false;

        checklist.push(
          '- [ ] Formulario: **no generado**'
        );

        blocked = true;
      }

      /**
       * --------------------------------------------------------
       * Checklist adicional de datos
       * --------------------------------------------------------
       */

      if (
        camposFaltantes.length >
        0
      ) {
        checklist.push(
          `- [ ] Datos empresariales: **${camposFaltantes.length} campo(s) faltante(s)**`
        );

        blocked = true;
      }

      if (
        camposPorConfirmar.length >
        0
      ) {
        checklist.push(
          `- [ ] Datos pendientes de confirmación: **${camposPorConfirmar.length} campo(s)**`
        );

        blocked = true;
      }

      /**
       * --------------------------------------------------------
       * Borrador de correo
       * --------------------------------------------------------
       */

      await fs.writeFile(
        path.join(
          dest,
          'checklist.md'
        ),
        [
          '# Checklist de soportes',
          '',
          `Caso: ${args.caso}`,
          `Fecha de revisión: ${now}`,
          '',
          ...checklist,
          ''
        ].join('\n')
      );

      await fs.writeFile(
        path.join(
          dest,
          'borrador-correo.md'
        ),
        [
          '# Borrador de correo',
          '',
          `**Para:** ${solicitud.de}`,
          `**Asunto:** Documentación para registro como proveedor – ${solicitud.cliente}`,
          '',
          'Estimados,',
          '',
          'Adjuntamos para su revisión el formulario de registro y los soportes disponibles.',
          'La documentación queda pendiente de revisión y firma del representante legal antes de su envío.',
          '',
          'Cordialmente,',
          'Periferia IT Group',
          ''
        ].join('\n')
      );

      /**
       * --------------------------------------------------------
       * Estado final del paquete
       * --------------------------------------------------------
       */

      const datosCompletos =
        camposFaltantes.length ===
        0;

      const confirmacionesResueltas =
        camposPorConfirmar.length ===
        0;

      const listoParaFirma =
        !blocked &&
        datosCompletos &&
        confirmacionesResueltas &&
        formularioDisponible;

      const data = {
        ruta: dest,

        listo_para_firma:
          listoParaFirma,

        formulario_disponible:
          formularioDisponible,

        campos_faltantes:
          camposFaltantes,

        campos_requieren_confirmacion:
          camposPorConfirmar,

        checklist
      };

      await log(
        ctx,
        args.caso,
        'proveedor_armar_paquete',
        listoParaFirma,
        `Paquete preparado; listo_para_firma=${listoParaFirma}`
      );

      return ok(data);
    } catch (e) {
      return fail(
        e instanceof Error
          ? e.message
          : 'No se pudo armar el paquete'
      );
    }
  }
};

/**
 * ============================================================
 * Tool: proveedor_simular_envio
 * ============================================================
 *
 * Esta herramienta NO realiza un envío real.
 *
 * Tiene dos controles:
 *
 * 1. El LLM debe enviar confirmado=true.
 * 2. El backend debe haber validado previamente la confirmación
 *    y establecer ctx.envioConfirmado=true.
 *
 * Así, el modelo por sí solo no puede autorizar el envío.
 */

export const proveedor_simular_envio = {
  description:
    'Escribe un archivo de envío simulado únicamente con confirmación explícita validada por el backend.',

  args: EnvioArgs,

  async execute(
    args: z.infer<typeof EnvioArgs>,
    ctx: ToolContext
  ) {
    try {
      /**
       * Primera barrera:
       * el argumento enviado por el agente debe ser true.
       */
      if (!args.confirmado) {
        return fail(
          'El envío simulado requiere confirmación explícita.'
        );
      }

      /**
       * Segunda barrera:
       * el backend debe haber validado realmente
       * la confirmación.
       */
	      /**
       * Tercera barrera:
       * aunque exista confirmación explícita, el paquete
       * debe estar completamente listo para firma.
       */
      const paqueteRaw = await proveedor_armar_paquete.execute(
  { caso: args.caso },
  ctx
);

let paquete: {
  ok: boolean;
  data?: {
    listo_para_firma?: boolean;
  };
  error?: string;
};

try {
  paquete = JSON.parse(paqueteRaw);
} catch {
  return fail(
    'No se pudo verificar el estado del paquete antes de simular el envío.'
  );
}

if (!paquete.ok) {
  return fail(
    paquete.error ??
      'No se pudo verificar el estado del paquete.'
  );
}

if (paquete.data?.listo_para_firma !== true) {
  return fail(
    'El paquete no está listo para firma o envío. Existen campos faltantes, datos pendientes de confirmación o soportes requeridos ausentes.'
  );
}
      if (
        ctx.envioConfirmado !== true
      ) {
        return fail(
          'La confirmación no fue validada por el backend.'
        );
      }

      const dest =
        path.resolve(
          ctx.directory,
          'out',
          args.caso,
          'ENVIO-SIMULADO.md'
        );

      await fs.mkdir(
        path.dirname(dest),
        {
          recursive: true
        }
      );

      await fs.writeFile(
        dest,
        [
          '# Envío simulado',
          '',
          `Caso: ${args.caso}`,
          'Confirmación validada por el backend.',
          'No se realizó ningún envío externo.'
        ].join('\n')
      );

      await log(
        ctx,
        args.caso,
        'proveedor_simular_envio',
        true,
        'Archivo de envío simulado creado después de validar la confirmación'
      );

      return ok({
        ruta: dest,
        envio_realizado: false,
        confirmacion_validada: true
      });
    } catch (e) {
      return fail(
        e instanceof Error
          ? e.message
          : 'No se pudo simular el envío'
      );
    }
  }
};

/**
 * ============================================================
 * Catálogo de herramientas
 * ============================================================
 */

export const tools = {
  proveedor_leer_solicitud,
  proveedor_mapear_campos,
  proveedor_generar_formulario,
  proveedor_armar_paquete,
  proveedor_simular_envio
};