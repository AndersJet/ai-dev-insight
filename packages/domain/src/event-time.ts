import {DomainError} from './errors.js';

/** UTC event reference, retaining all PostgreSQL microseconds instead of Date's millisecond truncation. */
export function eventTime(value:string|Date):string{
 const text=(value instanceof Date?value.toISOString():value).replace(' ','T').replace(/\+00$/,'Z');
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(text),at=Date.parse(text);
 if(!match||!Number.isFinite(at)||text.startsWith('0000')||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59||new Date(match[1]+'T00:00:00Z').toISOString().slice(0,10)!==match[1])throw new DomainError('invalid_request',400);
 const utc=new Date(at).toISOString();if(!/^\d{4}-/.test(utc)||utc.startsWith('0000'))throw new DomainError('invalid_request',400);
 return utc.slice(0,19)+'.'+(match[5]??'').padEnd(6,'0')+'Z';
}
