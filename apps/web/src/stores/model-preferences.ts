import {defineStore} from 'pinia';
import {ref} from 'vue';
import type {AnalyticsModelQueryDto} from '@adi/contracts';

export const useModelPreferences=defineStore('model-preferences',()=>{
 const owner=ref('');const scene=ref<NonNullable<AnalyticsModelQueryDto['scene']>>('Chat');const client=ref<NonNullable<AnalyticsModelQueryDto['client']>>('ide');const metric=ref<'tokens'|'calls'>('tokens');
 function setOwner(value:string){if(owner.value!==value){owner.value=value;scene.value='Chat';client.value='ide';metric.value='tokens';}}
 return {scene,client,metric,setOwner};
});
