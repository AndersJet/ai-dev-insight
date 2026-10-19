export interface E2EEnvironment {
  schema:string;portBase:number;webURL:string;apiURL:string;collectorURL:string;httpWebURL:string;databaseURL:string;artifactRoot:string;
}
export function e2eEnvironment(env?:Record<string,string|undefined>):E2EEnvironment;
export const environment:E2EEnvironment;
export function e2eArtifact(name:string):string;
