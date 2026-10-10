export type ChatMessage={role:'system'|'user'|'assistant'|'tool';content:string;tool_call_id?:string;name?:string};
export type ToolSpec={type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}};
export type LlmResponse={content:string|null;toolCalls:{id:string;name:string;arguments:string}[]};
export interface LlmAdapter{enviar(mensajes:ChatMessage[],herramientas:ToolSpec[]):Promise<LlmResponse>;}
