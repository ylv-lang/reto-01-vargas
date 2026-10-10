import 'dotenv/config';
import path from 'node:path';import fs from 'node:fs/promises';
import {proveedor_leer_solicitud,proveedor_mapear_campos,proveedor_generar_formulario,proveedor_armar_paquete} from './src/tools/proveedor.js';
const directory=process.cwd();const ctx={directory,sessionId:'demo-sin-modelo'};const cases=['co-industrias-delta','ec-corp-andina','hn-agroexport-sula','pa-logistica-istmo'];
await fs.rm(path.resolve(directory,'out'),{recursive:true,force:true});
for(const caso of cases){console.log(`\n=== ${caso} ===`);for(const [name,tool,args] of [['leer',proveedor_leer_solicitud,{caso}],['mapear',proveedor_mapear_campos,{caso}],['generar',proveedor_generar_formulario,{caso}],['paquete',proveedor_armar_paquete,{caso}]] as const){const raw=await tool.execute(args as any,ctx);const result=JSON.parse(raw);console.log(`${name}:`,result.ok?JSON.stringify(result.data):result.error);}}
