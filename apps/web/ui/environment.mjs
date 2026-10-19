import process from 'node:process';
export function uiEnvironment(env=process.env){
  const port=Number(env.ADI_UI_PORT??'4189');
  if(!/^[1-9][0-9]{3,4}$/.test(env.ADI_UI_PORT??'4189')||!Number.isInteger(port)||port<1024||port>65535)throw new Error('UI port must be a local unprivileged port');
  const reportRoot=port===4189?'.run':`.run/ui-${port}`;
  return {port,baseURL:`http://127.0.0.1:${port}`,reportRoot};
}
export const environment=uiEnvironment();
