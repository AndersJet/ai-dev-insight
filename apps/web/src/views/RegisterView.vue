<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { request } from '../api/http.js';
import AppLayout from '../layouts/AppLayout.vue';
const router=useRouter(),session=useSession();
const activating=computed(()=>!!session.user);
const email=ref(session.user?.email??''),name=ref(session.user?.display_name??''),password=ref(''),confirmation=ref(''),department=ref('');
const departments=ref<Array<{id:string;name:string}>>([]),loading=ref(true),busy=ref(false),error=ref('');
let active=true;
onMounted(async()=>{try{const result=await request<{data:{departments:Array<{id:string;name:string}>}}>('/api/v1/registration/setup');if(active)departments.value=result.data.departments;}catch(reason){if(active)error.value=reason instanceof Error?reason.message:'注册配置暂不可用';}finally{if(active)loading.value=false;}});
onBeforeUnmount(()=>{active=false;});
async function submit(){
  if(busy.value)return;error.value='';
  if(!activating.value&&password.value!==confirmation.value){error.value='两次输入的密码不一致';return;}
  busy.value=true;
  try{
    if(activating.value){
      await request('/api/v1/registration/activate','POST',department.value?{department_id:department.value}:{});
      await session.refresh();
    }else{
      await request('/api/v1/registration/complete','POST',{email:email.value.trim(),password:password.value,display_name:name.value.trim(),department_id:department.value});
      await session.login(email.value.trim(),password.value);
    }
    password.value='';confirmation.value='';if(active)await router.replace('/my/installations');
  }catch(reason){if(active)error.value=reason instanceof Error?reason.message:'注册失败';}finally{if(active)busy.value=false;}
}
</script>
<template>
  <AppLayout>
    <ElCard
      class="registration-card"
      shadow="never"
    >
      <div class="auth-eyebrow">
        AI DEV INSIGHT
      </div><h1>{{ activating ? '完成账号注册' : '注册工作账号' }}</h1><p>{{ activating ? '已通过登录确认身份，完成注册后即可安装个人 Hook。' : '使用本人企业邮箱，选择所属部门并设置密码，然后安装个人 Hook。' }}</p>
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      />
      <ElAlert
        v-if="!loading&&!error&&departments.length===0"
        title="暂无可选一级部门，请联系管理员先维护部门。"
        type="info"
        :closable="false"
      />
      <ElForm
        label-position="top"
        @submit.prevent="submit"
      >
        <ElFormItem
          label="工作邮箱"
          required
        >
          <ElInput
            v-model="email"
            :disabled="activating"
            type="email"
            aria-label="工作邮箱"
            autocomplete="username"
            placeholder="本人邮箱，例如 you@example.org"
            maxlength="254"
            required
          />
        </ElFormItem>
        <ElFormItem
          v-if="!activating"
          label="姓名"
          required
        >
          <ElInput
            v-model="name"
            aria-label="姓名"
            maxlength="128"
            required
          />
        </ElFormItem>
        <ElFormItem
          :label="activating ? '一级部门（已有归属时可不选）' : '一级部门'"
          :required="!activating"
        >
          <ElSelect
            v-model="department"
            aria-label="一级部门"
            class="full-width"
            placeholder="请选择一级部门"
            filterable
          >
            <ElOption
              v-for="item in departments"
              :key="item.id"
              :value="item.id"
              :label="item.name"
            />
          </ElSelect>
        </ElFormItem>
        <p class="field-help">
          {{ activating ? '完成注册时保留原姓名、部门和权限；尚未分配部门时，请选择一级部门。' : '管理员已建档的账号请先登录；没有密码请联系超级管理员领取临时密码。' }}
        </p>
        <ElFormItem
          v-if="!activating"
          label="密码"
          required
        >
          <ElInput
            v-model="password"
            aria-label="密码"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="128"
            show-password
            required
          />
        </ElFormItem>
        <ElFormItem
          v-if="!activating"
          label="确认密码"
          required
        >
          <ElInput
            v-model="confirmation"
            aria-label="确认密码"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="128"
            show-password
            required
          />
        </ElFormItem>
        <p class="field-help">
          <span v-if="!activating">密码为 12 至 128 个字符。</span>注册后先进入待采纳，首次成功上传正常 Hook 数据后自动变为已采纳。
        </p>
        <ElButton
          type="primary"
          native-type="submit"
          class="full-width"
          :loading="busy"
          :disabled="loading||(!activating&&!department)"
        >
          {{ activating ? '完成注册并进入采集安装' : '注册并进入采集安装' }}
        </ElButton>
      </ElForm>
      <div class="registration-links">
        <RouterLink :to="activating ? session.user!.default_route : '/login'">
          {{ activating ? '返回工作空间' : '已有账号，去登录' }}
        </RouterLink>
      </div>
    </ElCard>
  </AppLayout>
</template>
<style scoped>
.registration-card{max-width:560px;width:100%;margin:28px auto}.registration-links{display:flex;justify-content:space-between;gap:16px;margin-top:20px}.registration-card p{line-height:1.7}
</style>
