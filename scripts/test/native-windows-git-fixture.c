/* Developer-only adversarial Git process. No repo reads, shell or network.
 * Build ARM64 or x64 for the target Windows test host; never package this exe.
 * Called by the installed sender: append an attempt, start a sleeping child,
 * then stall or emit 262145 bytes. File/HTTP/process boundaries are observable.
 */
/* Minimal kernel32 declarations keep this fixture free of a CRT/guest SDK.
 * Structures use the documented 64-bit Windows ABI (ARM64 and x64).
 */
typedef unsigned long DWORD;
typedef int BOOL;
typedef __WCHAR_TYPE__ WCHAR;
typedef void *HANDLE;
#define WINAPI __stdcall
#define API __declspec(dllimport)
#define FALSE 0
#define FILE_SHARE_READ 1
#define FILE_SHARE_WRITE 2
#define FILE_SHARE_DELETE 4
#define FILE_APPEND_DATA 4
#define GENERIC_WRITE 0x40000000
#define OPEN_ALWAYS 4
#define CREATE_ALWAYS 2
#define FILE_ATTRIBUTE_NORMAL 128
#define CREATE_NO_WINDOW 0x08000000
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#define INVALID_HANDLE_VALUE ((HANDLE)-1)
typedef struct {
 DWORD cb; WCHAR *reserved,*desktop,*title;
 DWORD x,y,width,height,chars_x,chars_y,fill,flags;
 unsigned short show,reserved_bytes; void *reserved_pointer;
 HANDLE input,output,error;
} STARTUPINFOW;
typedef struct { HANDLE hProcess,hThread; DWORD dwProcessId,dwThreadId; } PROCESS_INFORMATION;
API WCHAR *WINAPI GetCommandLineW(void);
API DWORD WINAPI GetModuleFileNameW(HANDLE,WCHAR *,DWORD);
API HANDLE WINAPI CreateFileW(const WCHAR *,DWORD,DWORD,void *,DWORD,DWORD,HANDLE);
API BOOL WINAPI WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
API BOOL WINAPI CloseHandle(HANDLE);
API BOOL WINAPI CreateProcessW(const WCHAR *,WCHAR *,void *,void *,BOOL,DWORD,void *,const WCHAR *,STARTUPINFOW *,PROCESS_INFORMATION *);
API HANDLE WINAPI GetStdHandle(DWORD);
API void WINAPI Sleep(DWORD);
API DWORD WINAPI GetCurrentProcessId(void);
API __declspec(noreturn) void WINAPI ExitProcess(DWORD);
_Static_assert(sizeof(DWORD)==4 && sizeof(WCHAR)==2,"Windows scalar ABI");
_Static_assert(sizeof(STARTUPINFOW)==104 && sizeof(PROCESS_INFORMATION)==24,"Windows 64-bit process ABI");

static WCHAR self[2048], command[2064];
static unsigned char output[262145];
static unsigned length(const WCHAR *text) { unsigned n=0; while(text[n]) n++; return n; }
static void copy(WCHAR *to,const WCHAR *from) { do { *to++=*from; } while(*from++); }
static int contains(const WCHAR *text,const WCHAR *word) {
  for(;*text;text++) { unsigned n=0; while(word[n] && word[n]==text[n]) n++; if(!word[n]) return 1; }
  return 0;
}
static void write_file(const WCHAR *path,DWORD access,DWORD creation,const void *bytes,DWORD count) {
  HANDLE file=CreateFileW(path,access,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,0,creation,FILE_ATTRIBUTE_NORMAL,0);
  if(file==INVALID_HANDLE_VALUE) ExitProcess(21);
  DWORD written=0;
  if(!WriteFile(file,bytes,count,&written,0) || written!=count) ExitProcess(22);
  CloseHandle(file);
}
void WINAPI fixture_entry(void) {
  const WCHAR *args=GetCommandLineW();
  unsigned n=length(args);
  if(n>=6 && contains(args+n-6,L" child")) { Sleep(30000); ExitProcess(0); }
  int oversized=contains(args,L"output-project");
  if(!GetModuleFileNameW(0,self,2048)) ExitProcess(23);
  unsigned end=length(self), filename=0;
  for(unsigned i=0;i<end;i++) if(self[i]==L'\\') filename=i+1;
  if(end+10>=2064) ExitProcess(24);
  command[0]=L'"'; copy(command+1,self); copy(command+end+1,L"\" child");
  copy(self+filename,L"attempts.txt");
  const char newline='\n'; write_file(self,FILE_APPEND_DATA,OPEN_ALWAYS,&newline,1);
  copy(self+filename,L"parent.pid.bin");
  DWORD parent=GetCurrentProcessId(); write_file(self,GENERIC_WRITE,CREATE_ALWAYS,&parent,sizeof(parent));
  if(!GetModuleFileNameW(0,self,2048)) ExitProcess(25);
  STARTUPINFOW startup; PROCESS_INFORMATION child;
  for(unsigned i=0;i<sizeof(startup);i++) ((volatile unsigned char *)&startup)[i]=0;
  for(unsigned i=0;i<sizeof(child);i++) ((volatile unsigned char *)&child)[i]=0;
  startup.cb=sizeof(startup);
  if(!CreateProcessW(self,command,0,0,FALSE,CREATE_NO_WINDOW,0,0,&startup,&child)) ExitProcess(26);
  CloseHandle(child.hThread); CloseHandle(child.hProcess);
  copy(self+filename,L"child.pid.bin");
  write_file(self,GENERIC_WRITE,CREATE_ALWAYS,&child.dwProcessId,sizeof(child.dwProcessId));
  if(oversized) {
    for(unsigned i=0;i<sizeof(output);i++) output[i]='x';
    DWORD written=0; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output),&written,0);
  } else Sleep(30000);
  ExitProcess(0);
}
