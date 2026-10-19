// Compiled once by the Windows installer with the system .NET framework.
// No compiler, shell interpolation or process-tree enumeration on the Hook path.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Adi.Native {
  public static class ProcessRunner {
    public const int Protocol = 1;
    const uint Suspended = 4, NoWindow = 0x08000000, UnicodeEnvironment = 0x400;
    const uint KillOnClose = 0x2000, StartUseHandles = 0x100, WaitTimeout = 258;
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
      public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
      public int Size; public string Reserved, Desktop, Title;
      public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
      public ushort Show,ReservedSize; public IntPtr Reserved2,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
      public IntPtr Process,Thread; public uint ProcessId,ThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
      public long ProcessTime,JobTime; public uint Flags;
      public UIntPtr Minimum,Maximum; public uint ActiveProcesses;
      public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
      public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public BasicLimits Basic; public IoCounters Io;
      public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SecurityAttributes security,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    sealed class Capture {
      public volatile bool Done,Limited,Failed;
      public readonly MemoryStream Bytes = new MemoryStream();
      public Capture(Stream stream,int limit) {
        var thread=new Thread(delegate() {
          try {
            var buffer=new byte[16384];int count;
            while((count=stream.Read(buffer,0,buffer.Length))>0) {
              if(Bytes.Length+count>limit){Limited=true;break;}
              Bytes.Write(buffer,0,count);
            }
          }catch{Failed=true;}finally{Done=true;}
        });
        thread.IsBackground=true;thread.Start();
      }
    }
    sealed class InputCopy {
      public volatile bool Limited,Failed;
      public InputCopy(Stream source,Stream destination) {
        var thread=new Thread(delegate() {
          try {
            var buffer=new byte[16384];int count,total=0;
            while((count=source.Read(buffer,0,buffer.Length))>0) {
              total+=count;if(total>2095104){Limited=true;break;}
              destination.Write(buffer,0,count);
            }
          }catch{Failed=true;}finally{try{destination.Dispose();}catch{}}
        });
        thread.IsBackground=true;thread.Start();
      }
    }
    static string Quote(string value) {
      var result=new StringBuilder("\"");int slashes=0;
      foreach(char c in value) {
        if(c=='\\'){slashes++;continue;}
        if(c=='"'){result.Append('\\',slashes*2+1).Append('"');slashes=0;continue;}
        result.Append('\\',slashes).Append(c);slashes=0;
      }
      return result.Append('\\',slashes*2).Append('"').ToString();
    }
    static string Command(string executable,string[] arguments) {
      var result=new StringBuilder(Quote(executable));
      foreach(string argument in arguments)result.Append(' ').Append(Quote(argument));
      return result.ToString();
    }
    static IntPtr GitEnvironment() {
      var variables=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
        string key=(string)entry.Key;
        if(Regex.IsMatch(key,@"^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE)$",RegexOptions.IgnoreCase))continue;
        variables[key]=(string)entry.Value;
      }
      variables["GIT_TERMINAL_PROMPT"]="0";variables["GIT_OPTIONAL_LOCKS"]="0";variables["LC_ALL"]="C";
      var block=new StringBuilder();
      foreach(var entry in variables)block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
      block.Append('\0');return Marshal.StringToHGlobalUni(block.ToString());
    }
    static void Pipe(ref IntPtr read,ref IntPtr write,bool parentRead) {
      var security=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Inherit=1};
      if(!CreatePipe(out read,out write,ref security,0)||!SetHandleInformation(parentRead?read:write,1,0))throw new Exception("process_pipe_failed");
    }
    static void Close(ref IntPtr handle){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
    static FileStream StreamFor(ref IntPtr handle,FileAccess access) {
      var owner=new SafeFileHandle(handle,true);handle=IntPtr.Zero;
      return new FileStream(owner,access,4096,false);
    }
    static Dictionary<string,object> Execute(string executable,string[] arguments,Stream input,int timeout,bool git) {
      var clock=Stopwatch.StartNew();
      IntPtr job=IntPtr.Zero,environment=IntPtr.Zero,inRead=IntPtr.Zero,inWrite=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero;
      var process=new ProcessInfo();FileStream stdin=null,stdout=null,stderr=null;
      try {
        if(timeout<=0)throw new Exception("timeout");
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("process_job_failed");
        var limits=new ExtendedLimits();limits.Basic.Flags=KillOnClose;
        if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))))throw new Exception("process_job_failed");
        Pipe(ref inRead,ref inWrite,false);Pipe(ref outRead,ref outWrite,true);Pipe(ref errRead,ref errWrite,true);
        var startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfo)),Flags=StartUseHandles,Input=inRead,Output=outWrite,Error=errWrite};
        if(git)environment=GitEnvironment();
        if(!CreateProcess(executable,new StringBuilder(Command(executable,arguments)),IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnvironment,environment,null,ref startup,out process))throw new Exception("process_start_failed");
        // The child cannot execute or fork before it belongs to this job.
        if(!AssignProcessToJobObject(job,process.Process))throw new Exception("process_job_failed");
        Close(ref inRead);Close(ref outWrite);Close(ref errWrite);
        stdin=StreamFor(ref inWrite,FileAccess.Write);stdout=StreamFor(ref outRead,FileAccess.Read);stderr=StreamFor(ref errRead,FileAccess.Read);
        var output=new Capture(stdout,262144);var errors=new Capture(stderr,262144);
        InputCopy copy=null;if(input==null){stdin.Dispose();stdin=null;}else{copy=new InputCopy(input,stdin);}
        if(ResumeThread(process.Thread)==uint.MaxValue)throw new Exception("process_start_failed");
        while(true) {
          if(clock.ElapsedMilliseconds>=timeout)throw new Exception("timeout");
          if(output.Limited||errors.Limited||(copy!=null&&copy.Limited))throw new Exception("output_limit");
          uint ready=WaitForSingleObject(process.Process,2);
          if(ready==0)break;if(ready!=WaitTimeout)throw new Exception("process_wait_failed");
        }
        uint exit;if(!GetExitCodeProcess(process.Process,out exit))throw new Exception("process_wait_failed");
        // Also kill descendants whose root has already exited, before reading EOF.
        Close(ref job);
        while(!output.Done||!errors.Done) {
          if(clock.ElapsedMilliseconds>=timeout)throw new Exception("timeout");
          Thread.Sleep(1);
        }
        if(output.Limited||errors.Limited)throw new Exception("output_limit");
        if(output.Failed||errors.Failed)throw new Exception("process_read_failed");
        var utf8=new UTF8Encoding(false,true);string outText,errorText;
        try{outText=utf8.GetString(output.Bytes.ToArray());errorText=utf8.GetString(errors.Bytes.ToArray());}
        catch{throw new Exception("invalid_git_output");}
        return new Dictionary<string,object>{{"code",(int)exit},{"out",outText},{"err",errorText}};
      } finally {
        Close(ref job);
        // Assignment can fail while the process is still suspended.
        if(process.Process!=IntPtr.Zero){TerminateProcess(process.Process,1);Close(ref process.Process);}
        Close(ref process.Thread);Close(ref inRead);Close(ref inWrite);Close(ref outRead);Close(ref outWrite);Close(ref errRead);Close(ref errWrite);
        if(stdin!=null)try{stdin.Dispose();}catch{}
        if(stdout!=null)try{stdout.Dispose();}catch{}
        if(stderr!=null)try{stderr.Dispose();}catch{}
        if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
      }
    }
    public static Dictionary<string,object> RunGit(string executable,string[] arguments,int timeout) {
      return Execute(executable,arguments,null,timeout,true);
    }
    public static void SendWorker(string executable,string[] arguments,Stream input,int timeout) {
      Execute(executable,arguments,input,timeout,false);
    }
    public static void Main(string[] arguments) {
      var clock=Stopwatch.StartNew();
      try {
        if(arguments.Length!=1)return;
        // Keep stdin, local I/O and HTTP on a background thread. Returning from
        // Main ends this short-lived process even if input or a disk stalls;
        // Windows closes its Git Job handles and kills any descendants.
        var worker=new Thread(delegate() {
          try {
            var sender=Assembly.GetExecutingAssembly().GetType("Adi.Native.HookSender",true);
            sender.GetMethod("Send").Invoke(null,new object[]{arguments[0],Console.OpenStandardInput(),clock});
          }catch{}
        });
        worker.IsBackground=true;worker.Start();
        worker.Join(Math.Max(1,750-(int)clock.ElapsedMilliseconds));
      }catch{ /* Never send arbitrary diagnostics or credentials to the IDE. */ }
    }
  }
}
