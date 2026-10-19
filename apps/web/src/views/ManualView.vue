<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import { useSession } from '../stores/session.js';
import { manualRole } from '../router/manual.js';
import system from '../manuals/system-admin.md?raw';
import anc from '../manuals/anc-admin.md?raw';
import department from '../manuals/department-admin.md?raw';
import employee from '../manuals/employee.md?raw';
const session = useSession();
const pages = {'system-admin':{title:'系统管理员操作手册',text:system},'anc-admin':{title:'组织管理员操作手册',text:anc},'department-admin':{title:'一级部门管理员操作手册',text:department},employee:{title:'普通员工操作手册',text:employee}};
const page = computed(() => pages[manualRole(session.user?.roles ?? [])]);
const rendered = computed(() => {
  const parser = new MarkdownIt({html:false,linkify:false,maxNesting:20}), tokens = parser.parse(page.value.text,{}), toc: Array<{id:string;text:string}> = [];
  for(let i=0;i<tokens.length;i++) if(tokens[i]?.type==='heading_open'){const id=`manual-section-${toc.length}`;tokens[i]!.attrSet('id',id);toc.push({id,text:tokens[i+1]?.content??''});}
  return {toc,html:parser.renderer.render(tokens,parser.options,{})};
});
</script>
<template>
  <section class="manual-page">
    <header class="manual-heading">
      <div class="manual-title">
        <div>
          <p class="manual-eyebrow">
            AI DEV INSIGHT · 操作指南
          </p><h1>{{ page.title }}</h1>
        </div>
      </div><div class="manual-actions">
        <RouterLink to="/my/installations">
          采集安装与下载
        </RouterLink>
      </div>
    </header>
    <div class="manual-layout">
      <nav
        aria-label="手册目录"
        class="manual-toc"
      >
        <a
          v-for="item in rendered.toc"
          :key="item.id"
          :href="`#${item.id}`"
        >{{ item.text }}</a><RouterLink to="/my/installations">
          进入本人采集安装
        </RouterLink>
      </nav>
      <!-- Static authored Markdown only; raw HTML is disabled. -->
      <article
        class="manual-article"
        v-html="rendered.html"
      />
    </div>
  </section>
</template>
<style scoped>
.manual-page{max-width:1180px;margin:0 auto;padding:24px;width:100%;box-sizing:border-box}.manual-heading{display:flex;justify-content:space-between;gap:24px;align-items:center;border-bottom:1px solid var(--el-border-color);padding-bottom:24px}.manual-title{display:flex;align-items:center;gap:16px}.manual-heading h1{font-size:28px;margin:4px 0}.manual-eyebrow{font-size:12px;letter-spacing:.1em;color:var(--el-text-color-secondary)}.manual-actions{display:flex;gap:18px;white-space:nowrap}.manual-downloads{padding:20px;margin:24px 0;border:1px solid var(--el-border-color);border-radius:10px;background:var(--el-bg-color)}.manual-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:40px;padding-top:28px}.manual-toc{display:flex;flex-direction:column;gap:16px;position:sticky;top:24px;align-self:start;font-size:14px;line-height:1.5}.manual-article{font-size:15px;line-height:1.9;overflow-wrap:anywhere}.manual-article :deep(h3){margin-top:32px;font-size:20px;scroll-margin-top:100px}.manual-article :deep(li){margin-bottom:10px}.manual-article :deep(code){background:var(--el-fill-color-light);padding:2px 5px;border-radius:4px}.manual-article :deep(p){margin:0 0 18px}.manual-public{background:var(--el-bg-color);border-radius:16px}.manual-page a{color:var(--el-color-primary);text-decoration:none}
@media(max-width:760px){.manual-page{padding:16px}.manual-layout{grid-template-columns:1fr;gap:20px}.manual-toc{position:static;flex-direction:row;flex-wrap:wrap;border-bottom:1px solid var(--el-border-color);padding-bottom:20px}.manual-heading{align-items:flex-start;flex-direction:column}.manual-heading h1{font-size:23px}.manual-downloads .el-button{margin:6px 8px 6px 0}}
</style>
