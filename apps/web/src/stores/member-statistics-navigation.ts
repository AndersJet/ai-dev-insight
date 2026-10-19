import {defineStore} from 'pinia';
export const useMemberStatisticsNavigation=defineStore('member-statistics-navigation',{
 state:()=>({owner:'',path:'',search:'',appliedSearch:'',page:0,cursors:[undefined] as (string|undefined)[],scroll:0,restore:false}),
 actions:{forOwner(id:string){if(this.owner!==id){this.$reset();this.owner=id;}}},
});
