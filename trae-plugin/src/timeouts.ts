/** Background work may wait longer; the native Hook's interactive budget is separate. */
export const pluginTimeouts={platform:10000,collection:3000,hookDownload:30000,releaseDownload:90000,hookInstall:90000,gitProbe:5000,runtimeLock:5000} as const;
export function platformRequestTimeout(path:string){
  return ['/api/v1/plugin/sources','/api/v1/plugin/observations'].includes(path)?pluginTimeouts.collection:pluginTimeouts.platform;
}
