import OpenAI from 'openai';
import type {ChatMessage,ToolSpec,LlmAdapter,LlmResponse} from './adapter.js';
export class OpenAiAdapter implements LlmAdapter{
 private client:OpenAI; private model:string;
 constructor(){const key=process.env.OPENAI_API_KEY;if(!key)throw new Error('Falta configurar OPENAI_API_KEY en el backend');this.client=new OpenAI({apiKey:key,timeout:45000});this.model=process.env.OPENAI_MODEL??'gpt-4o-mini';}
 async enviar(mensajes:ChatMessage[],herramientas:ToolSpec[]):Promise<LlmResponse>{const response=await this.client.chat.completions.create({model:this.model,messages:mensajes as OpenAI.Chat.Completions.ChatCompletionMessageParam[],tools:herramientas,tool_choice:'auto'});const msg=response.choices[0]?.message;return {content:msg?.content??null,toolCalls:(msg?.tool_calls??[]).filter((t)=>t.type==='function').map(t=>({id:t.id,name:t.function.name,arguments:t.function.arguments}))};}
}
