// The Windows Hook hot path runs in the installer's compiled .NET executable.
// PowerShell is used for installation only; no employee Node or child shell.
namespace Adi.Native {
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

  internal static class NativeJson {
    public static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
    public static readonly DateTime Epoch=new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);
    public static Dictionary<string,object> Object(params object[] pairs) {
      var value=new Dictionary<string,object>(StringComparer.Ordinal);
      for(int i=0;i<pairs.Length;i+=2)value.Add((string)pairs[i],pairs[i+1]);return value;
    }
    public static object Value(IDictionary value,string key){return value!=null&&value.Contains(key)?value[key]:null;}
    public static string Text(IDictionary value,string key){return Value(value,key) as string;}
    public static string Encode(object value){var text=new StringBuilder();Write(text,value,0);if(text.Length>2097152)throw new Exception("json_limit");return text.ToString();}
    static void Write(StringBuilder text,object value,int depth){
      if(depth>32||text.Length>2097152)throw new Exception("json_limit");
      if(value==null){text.Append("null");return;}var word=value as string;
      if(word!=null){Quote(text,word);return;}if(value is bool){text.Append((bool)value?"true":"false");return;}
      var map=value as IDictionary;if(map!=null){text.Append('{');bool comma=false;foreach(DictionaryEntry entry in map){if(comma)text.Append(',');Quote(text,(string)entry.Key);text.Append(':');Write(text,entry.Value,depth+1);comma=true;}text.Append('}');return;}
      var list=value as IList;if(list!=null){text.Append('[');bool comma=false;foreach(object item in list){if(comma)text.Append(',');Write(text,item,depth+1);comma=true;}text.Append(']');return;}
      if(value is byte||value is int||value is long){text.Append(Convert.ToString(value,CultureInfo.InvariantCulture));return;}
      if(value is double){double number=(double)value;if(double.IsInfinity(number)||double.IsNaN(number))throw new Exception("invalid_json");text.Append(number.ToString("R",CultureInfo.InvariantCulture));return;}
      throw new Exception("invalid_json_value");
    }
    static void Quote(StringBuilder text,string value){
      text.Append('"');for(int i=0;i<value.Length;i++){char letter=value[i];
        if(char.IsHighSurrogate(letter)&&i+1<value.Length&&char.IsLowSurrogate(value[i+1])){text.Append(letter).Append(value[++i]);continue;}
        switch(letter){
        case '"':text.Append("\\\"");break;case '\\':text.Append("\\\\");break;
        case '\b':text.Append("\\b");break;case '\f':text.Append("\\f");break;case '\n':text.Append("\\n");break;case '\r':text.Append("\\r");break;case '\t':text.Append("\\t");break;
        default:if(letter<32||letter=='\''||letter=='<'||letter=='>'||letter=='&'||letter=='\u2028'||letter=='\u2029'||char.IsSurrogate(letter))text.Append("\\u").Append(((int)letter).ToString("x4",CultureInfo.InvariantCulture));else text.Append(letter);break;
      }}text.Append('"');
    }
    public static object Decode(string value,int limit,int depth){return new Reader(value,limit,depth).Read();}
    // A bounded JSON reader avoids the ASP.NET configuration initialization
    // on the first DeserializeObject call. Raw Hook text is never re-encoded.
    sealed class Reader {
      readonly string text;readonly int maxDepth;int at;
      public Reader(string text,int limit,int maxDepth){if(text==null||text.Length>limit)throw new Exception("json_limit");this.text=text;this.maxDepth=maxDepth;}
      Exception Invalid(){return new Exception("invalid_json");}
      void White(){while(at<text.Length&&(text[at]==' '||text[at]=='\t'||text[at]=='\r'||text[at]=='\n'))at++;}
      bool Take(char value){White();if(at<text.Length&&text[at]==value){at++;return true;}return false;}
      public object Read(){object value=Value(0);White();if(at!=text.Length)throw Invalid();return value;}
      object Value(int depth){
        White();if(at>=text.Length||depth>maxDepth)throw Invalid();char next=text[at];
        if(next=='"')return String();
        if(next=='{'){
          at++;var result=new Dictionary<string,object>(StringComparer.Ordinal);if(Take('}'))return result;
          do{White();if(at>=text.Length||text[at]!='"')throw Invalid();string key=String();if(!Take(':'))throw Invalid();result[key]=Value(depth+1);if(Take('}'))return result;}while(Take(','));throw Invalid();
        }
        if(next=='['){at++;var result=new List<object>();if(Take(']'))return result.ToArray();do{result.Add(Value(depth+1));if(Take(']'))return result.ToArray();}while(Take(','));throw Invalid();}
        if(next=='t'){Literal("true");return true;}if(next=='f'){Literal("false");return false;}if(next=='n'){Literal("null");return null;}
        int start=at;if(next=='-')at++;if(at>=text.Length)throw Invalid();
        if(text[at]=='0')at++;else{if(text[at]<'1'||text[at]>'9')throw Invalid();while(at<text.Length&&text[at]>='0'&&text[at]<='9')at++;}
        if(at<text.Length&&text[at]=='.'){at++;int digits=at;while(at<text.Length&&text[at]>='0'&&text[at]<='9')at++;if(at==digits)throw Invalid();}
        if(at<text.Length&&(text[at]=='e'||text[at]=='E')){at++;if(at<text.Length&&(text[at]=='+'||text[at]=='-'))at++;int digits=at;while(at<text.Length&&text[at]>='0'&&text[at]<='9')at++;if(at==digits)throw Invalid();}
        string number=text.Substring(start,at-start);long integer;if(long.TryParse(number,NumberStyles.AllowLeadingSign,CultureInfo.InvariantCulture,out integer))return integer;
        double floating;if(!double.TryParse(number,NumberStyles.Float,CultureInfo.InvariantCulture,out floating)||double.IsInfinity(floating)||double.IsNaN(floating))throw Invalid();return floating;
      }
      void Literal(string value){if(at+value.Length>text.Length||string.CompareOrdinal(text,at,value,0,value.Length)!=0)throw Invalid();at+=value.Length;}
      string String(){
        if(text[at++]!='"')throw Invalid();var result=new StringBuilder();
        while(at<text.Length){char next=text[at++];if(next=='"')return result.ToString();if(next<32)throw Invalid();
          if(next!='\\'){result.Append(next);continue;}if(at>=text.Length)throw Invalid();char escape=text[at++];
          switch(escape){
            case '"':case '\\':case '/':result.Append(escape);break;
            case 'b':result.Append('\b');break;case 'f':result.Append('\f');break;case 'n':result.Append('\n');break;case 'r':result.Append('\r');break;case 't':result.Append('\t');break;
            case 'u':int code;if(at+4>text.Length||!int.TryParse(text.Substring(at,4),NumberStyles.AllowHexSpecifier,CultureInfo.InvariantCulture,out code))throw Invalid();result.Append((char)code);at+=4;break;
            default:throw Invalid();
          }
        }
        throw Invalid();
      }
    }
    public static string Hash(object value) {
      using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Utf8.GetBytes(Encode(value)))).Replace("-","").ToLowerInvariant();
    }
    public static bool Keys(IDictionary value,params string[] keys) {
      if(value==null||value.Count!=keys.Length)return false;
      foreach(string key in keys)if(!value.Contains(key))return false;return true;
    }
    public static bool Uuid(string value){return value!=null&&Regex.IsMatch(value,@"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$");}
    public static string ProjectPath(object input) {
      string value=input as string;
      if(string.IsNullOrEmpty(value)||value.Length>4096||Regex.IsMatch(value,@"[\x00-\x1f\x7f]"))return null;
      value=value.Replace('\\','/');
      if(!Regex.IsMatch(value,@"^[a-z]:/",RegexOptions.IgnoreCase)&&!Regex.IsMatch(value,@"^//[^/]+/[^/]+"))return null;
      if(Regex.IsMatch(value,@"^[a-z]:",RegexOptions.IgnoreCase))value=char.ToUpperInvariant(value[0])+value.Substring(1);
      return value.TrimEnd('/');
    }
    public static int Nodes(object value,int limit) {
      var pending=new Stack<object>();pending.Push(value);int nodes=0;
      while(pending.Count>0&&nodes<=limit) {
        object item=pending.Pop();nodes++;var dictionary=item as IDictionary;var list=item as IList;
        if(dictionary!=null)foreach(object entry in dictionary.Values)pending.Push(entry);
        else if(list!=null)foreach(object entry in list)pending.Push(entry);
        if(pending.Count+nodes>limit)return limit+1;
      }
      return nodes;
    }
  }

  internal sealed class NativeStateIo {
    public readonly string Root;
    readonly SecurityIdentifier sid=WindowsIdentity.GetCurrent().User;
    readonly Stopwatch budget;readonly int deadline;
    public NativeStateIo(string root,Stopwatch budget,int deadline){Root=root;this.budget=budget;this.deadline=deadline;}
    public void Check(){if(budget.ElapsedMilliseconds>=deadline)throw new Exception("timeout");}
    FileAttributes? Attributes(string path) {
      try{return File.GetAttributes(path);}catch(FileNotFoundException){return null;}catch(DirectoryNotFoundException){return null;}
    }
    public void Assert(string path,bool directory) {
      Check();string full=Path.GetFullPath(path),cursor=full;
      while(cursor!=null) {
        var attributes=Attributes(cursor);
        if(attributes.HasValue) {
          if((attributes.Value&FileAttributes.ReparsePoint)!=0)throw new Exception("unsafe_state_path");
          if(cursor==full&&((attributes.Value&FileAttributes.Directory)!=0)!=directory)throw new Exception("unsafe_state_path");
        }
        string parent=Path.GetDirectoryName(cursor);if(parent==cursor)break;cursor=parent;
      }
      if(!Attributes(full).HasValue)return;
      FileSystemSecurity acl=directory?(FileSystemSecurity)Directory.GetAccessControl(full,AccessControlSections.Owner|AccessControlSections.Access):File.GetAccessControl(full,AccessControlSections.Owner|AccessControlSections.Access);
      if(acl.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value)throw new Exception("unsafe_state_permissions");
      foreach(FileSystemAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier)))
        if(rule.AccessControlType==AccessControlType.Allow&&rule.IdentityReference.Value!=sid.Value)throw new Exception("unsafe_state_permissions");
    }
    public void DirectoryFor(string path) {
      Assert(path,true);if(Directory.Exists(path))return;
      Directory.CreateDirectory(path);var acl=new DirectorySecurity();acl.SetOwner(sid);acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      Directory.SetAccessControl(path,acl);
    }
    public string Read(string path,int limit) {
      Assert(path,false);if(!File.Exists(path))return null;
      using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
        if(stream.Length>limit)throw new Exception("oversized_file");
        var bytes=new byte[limit+1];int offset=0,count;
        while(offset<bytes.Length&&(count=stream.Read(bytes,offset,bytes.Length-offset))>0)offset+=count;
        if(offset>limit)throw new Exception("oversized_file");return NativeJson.Utf8.GetString(bytes,0,offset);
      }
    }
    public void Atomic(string path,object value) {
      Assert(path,false);string temp=Path.Combine(Path.GetDirectoryName(path),".state-"+Guid.NewGuid().ToString());
      try {
        using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
          FileSecurity owner=File.GetAccessControl(temp,AccessControlSections.Owner);if(owner.GetOwner(typeof(SecurityIdentifier)).Value!=sid.Value){owner.SetOwner(sid);File.SetAccessControl(temp,owner);}
          byte[] bytes=NativeJson.Utf8.GetBytes(NativeJson.Encode(value));stream.Write(bytes,0,bytes.Length);stream.Flush(true);
        }
        Check();if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);
      }finally{if(File.Exists(temp))File.Delete(temp);}
    }
    public FileStream Lock(){string path=Path.Combine(Root,"state.lock");Assert(path,false);return new FileStream(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);}
    public IDictionary Json(string path,int limit) {
      string raw;try{raw=Read(path,limit);}catch(Exception error){if(error.Message=="oversized_file")return null;throw;}
      if(raw==null)return null;try{return NativeJson.Decode(raw,limit,16) as IDictionary;}catch{return null;}
    }
  }

  internal sealed class NativeProject {
    readonly NativeStateIo io;readonly IDictionary settings,payload;IDictionary state,context;string key,account,normalized,workspace,reason;
    NativeProject(NativeStateIo io,IDictionary settings,IDictionary payload){this.io=io;this.settings=settings;this.payload=payload;}
    static bool ValidState(IDictionary state) {
      long sequence;string text=NativeJson.Text(state,"sequence");
      // A malformed on-disk version is damaged identity, not a transient I/O
      // failure. Read errors still escape before this validation is reached.
      object version=NativeJson.Value(state,"version");
      bool versionOne=(version is int&&(int)version==1)||(version is long&&(long)version==1);
      return NativeJson.Keys(state,"version","collector_id","sequence","checksum")&&versionOne&&NativeJson.Uuid(NativeJson.Text(state,"collector_id"))&&text!=null&&Regex.IsMatch(text,@"^(0|[1-9][0-9]{0,18})$")&&long.TryParse(text,NumberStyles.None,CultureInfo.InvariantCulture,out sequence)&&NativeJson.Text(state,"checksum")==NativeJson.Hash(new object[]{state["collector_id"],text});
    }
    void SaveState(){state["checksum"]=NativeJson.Hash(new object[]{state["collector_id"],state["sequence"]});io.Atomic(Path.Combine(io.Root,"identity.json"),state);}
    static string CacheHash(IDictionary cache) {
      object observation=null;var value=NativeJson.Value(cache,"observation") as IDictionary;
      if(value!=null) {
        // A cached legacy observation must replay unchanged with its original
        // identity; new observations hash only their address records.
        var remotes=new List<object>();foreach(IDictionary remote in (IList)value["remotes"])remotes.Add(remote.Contains("name")?new object[]{remote["name"],remote["direction"],remote["address"]}:new object[]{remote["address"]});
        observation=new object[]{value["id"],value["sequence"],value["observed_at"],value["state"],value["reason"],value["git_root"],remotes.ToArray()};
      }
      return NativeJson.Hash(new object[]{cache["collector_id"],cache["account"],cache["workspace"],cache["attempt_at"],cache["attempt_tick"],cache["reservation"],cache["sequence"],observation});
    }
    void SaveCache(IDictionary cache){cache["checksum"]=CacheHash(cache);io.Atomic(key,cache);}
    IDictionary Cache() {
      try {
        string raw=io.Read(key,524288);if(raw==null)return null;
        var cache=NativeJson.Decode(raw,524288,16) as IDictionary;
        if(NativeJson.Uuid(NativeJson.Text(cache,"collector_id"))&&!object.Equals(cache["collector_id"],state["collector_id"]))return null;
        if(!NativeJson.Keys(cache,"version","collector_id","account","workspace","attempt_at","attempt_tick","reservation","sequence","observation","checksum")||Convert.ToInt64(cache["version"],CultureInfo.InvariantCulture)!=1||!object.Equals(cache["collector_id"],state["collector_id"])||!object.Equals(cache["account"],account)||!object.Equals(cache["workspace"],normalized))throw new Exception("invalid_cache");
        var observation=cache["observation"] as IDictionary;
        if(observation!=null) {
          if(!NativeJson.Keys(observation,"id","sequence","observed_at","state","reason","git_root","remotes"))throw new Exception("invalid_cache");
          foreach(IDictionary remote in (IList)observation["remotes"])if(!NativeJson.Keys(remote,"address")&&!NativeJson.Keys(remote,"name","direction","address"))throw new Exception("invalid_cache");
        }
        if(NativeJson.Text(cache,"checksum")!=CacheHash(cache))throw new Exception("invalid_cache");return cache;
      }catch{return NativeJson.Object("invalid",true);}
    }
    IDictionary Output(object observation){return NativeJson.Object("collector_id",state["collector_id"],"platform","windows","workspace",workspace,"unresolved_reason",reason,"observation",observation);}
    IDictionary Reservation(long now,long tick,object observation){return NativeJson.Object("version",1,"collector_id",state["collector_id"],"account",account,"workspace",normalized,"attempt_at",now,"attempt_tick",tick,"reservation",Guid.NewGuid().ToString(),"sequence",state["sequence"],"observation",observation,"checksum","");}
    IDictionary Run() {
      FileStream locked=null;
      try {
        io.DirectoryFor(io.Root);io.DirectoryFor(Path.Combine(io.Root,"cache"));
        workspace=NativeJson.Text(payload,"cwd");var roots=NativeJson.Value(payload,"workspace_roots") as IList;
        if(roots!=null&&roots.Count>1){workspace=null;reason="ambiguous_workspace";}
        else if(NativeJson.ProjectPath(workspace)==null) {
          workspace=roots!=null&&roots.Count==1?roots[0] as string:null;
          if(NativeJson.ProjectPath(workspace)==null){reason=NativeJson.Value(payload,"cwd")!=null||workspace!=null?"invalid_workspace":"missing_workspace";workspace=null;}
        }
        normalized=NativeJson.ProjectPath(workspace);
        account=NativeJson.Hash(new object[]{settings["installation_id"],settings["token"],settings["endpoint"],NativeJson.Value(settings,"runtime_generation")});
        key=Path.Combine(io.Root,"cache",NativeJson.Hash(new object[]{account,"windows",normalized})+".json");
        try{locked=io.Lock();}catch {
          state=io.Json(Path.Combine(io.Root,"identity.json"),16384);if(!ValidState(state))return null;
          var cached=Cache();return Output(cached!=null&&!cached.Contains("invalid")?cached["observation"]:null);
        }
        IDictionary reserved,entry=null;
        try {
          state=io.Json(Path.Combine(io.Root,"identity.json"),16384);bool fresh=!ValidState(state);
          if(fresh){state=NativeJson.Object("version",1,"collector_id",Guid.NewGuid().ToString(),"sequence","0","checksum","");SaveState();}
          if(workspace==null)return Output(null);
          if(!fresh)entry=Cache();long tick=(long)(Stopwatch.GetTimestamp()*1000.0/Stopwatch.Frequency),now=(long)(DateTime.UtcNow-NativeJson.Epoch).TotalMilliseconds;
          if(entry!=null&&entry.Contains("invalid")){SaveCache(Reservation(now,tick,null));return Output(null);}
          if(entry!=null) {
            long at=Convert.ToInt64(entry["attempt_at"],CultureInfo.InvariantCulture),previousTick=Convert.ToInt64(entry["attempt_tick"],CultureInfo.InvariantCulture);
            long elapsed=tick>=previousTick?tick-previousTick:now-at;
            if(elapsed<0){entry["attempt_at"]=now;entry["attempt_tick"]=tick;SaveCache(entry);return Output(entry["observation"]);}
            if(elapsed<300000)return Output(entry["observation"]);
          }
          if((string)state["sequence"]==long.MaxValue.ToString(CultureInfo.InvariantCulture)){state=NativeJson.Object("version",1,"collector_id",Guid.NewGuid().ToString(),"sequence","0","checksum","");entry=null;}
          state["sequence"]=(long.Parse((string)state["sequence"],CultureInfo.InvariantCulture)+1).ToString(CultureInfo.InvariantCulture);SaveState();
          reserved=Reservation(now,tick,entry==null?null:entry["observation"]);SaveCache(reserved);context=Output(null);
        }finally{locked.Dispose();locked=null;}
        io.Check();
        string activeGeneration=NativeRuntime.Generation(settings);if(activeGeneration==null||!object.Equals(activeGeneration,NativeJson.Value(settings,"runtime_generation")))return null;
        var found=NativeGit.Observe(workspace);
        var observation=NativeJson.Object("id",reserved["reservation"],"sequence",reserved["sequence"],"observed_at",NativeJson.Epoch.AddMilliseconds(Convert.ToInt64(reserved["attempt_at"],CultureInfo.InvariantCulture)).ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture),"state",found["state"],"reason",found["reason"],"git_root",found["git_root"],"remotes",found["remotes"]);
        context["observation"]=observation;
        try{locked=io.Lock();entry=Cache();if(entry!=null&&!entry.Contains("invalid")&&object.Equals(entry["reservation"],reserved["reservation"])){entry["observation"]=observation;SaveCache(entry);}}
        finally{if(locked!=null){locked.Dispose();locked=null;}}
        return context;
      }catch{return context;}finally{if(locked!=null)locked.Dispose();}
    }
    public static IDictionary Observe(string config,IDictionary settings,IDictionary payload,Stopwatch clock,int deadline) {
      string generation=NativeRuntime.Generation(settings);if(generation==null||!object.Equals(generation,NativeJson.Value(settings,"runtime_generation")))return null;
      try {
        string release=Path.GetDirectoryName(Path.GetFullPath(config));if(!NativeJson.Uuid(Path.GetFileName(release)))return null;
        string parent=Path.GetDirectoryName(release);var io=new NativeStateIo(Path.Combine(parent,"project-state"),clock,deadline);
        if(io.Read(Path.Combine(parent,".owned"),128)!="adi-native-client-v2")return null;
        return new NativeProject(io,settings,payload).Run();
      }catch{return null;}
    }
  }

  internal static class NativeGit {
    static readonly Regex Unsafe=new Regex(@"[\s\\\x00-\x1f\x7f]");
    static bool UnsafePath(string path){return Regex.IsMatch(path,@"[<>""']|%(?:0[0-9a-f]|1[0-9a-f]|7f)",RegexOptions.IgnoreCase);}
    static string Host(string value) {
      value=value.ToLowerInvariant();if(value.Length==0||value.Length>253||Regex.IsMatch(value,@"[\s\\/@?#%]"))return null;
      if(value.StartsWith("[",StringComparison.Ordinal)) {
        IPAddress ip;if(!Regex.IsMatch(value,@"^\[[0-9a-f:.]+\]$")||!IPAddress.TryParse(value.Substring(1,value.Length-2),out ip)||ip.AddressFamily!=System.Net.Sockets.AddressFamily.InterNetworkV6)return null;
        byte[] bytes=ip.GetAddressBytes();string[] words=new string[8];int start=-1,best=-1,length=0;
        for(int i=0;i<8;i++) {
          int word=bytes[i*2]*256+bytes[i*2+1];words[i]=word.ToString("x",CultureInfo.InvariantCulture);
          if(word==0){if(start<0)start=i;if(i-start+1>length){best=start;length=i-start+1;}}else start=-1;
        }
        if(length<2)return "["+string.Join(":",words)+"]";
        return "["+string.Join(":",words,0,best)+"::"+string.Join(":",words,best+length,8-best-length)+"]";
      }
      if(Regex.IsMatch(value,@"^[0-9.]+$")) {
        string[] parts=value.Split('.');if(parts.Length!=4)return null;
        foreach(string part in parts)if(!Regex.IsMatch(part,@"^(0|[1-9][0-9]{0,2})$")||int.Parse(part,CultureInfo.InvariantCulture)>255)return null;
        return value;
      }
      foreach(string part in value.Split('.'))if(part.Length>63||!Regex.IsMatch(part,@"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"))return null;
      return value;
    }
    static string Address(string value) {
      if(string.IsNullOrEmpty(value)||value.Length>4096||Unsafe.IsMatch(value))return null;
      if(value.IndexOf("://",StringComparison.Ordinal)<0) {
        if(Regex.IsMatch(value,@"^[a-z]:",RegexOptions.IgnoreCase))return null;
        var match=Regex.Match(value,@"^(?:[^:@/]+@)?(\[[^\]]+\]|[^:/@]+):([^?#]+)(?:[?#].*)?$");
        if(!match.Success||match.Groups[2].Value.StartsWith(":",StringComparison.Ordinal)||UnsafePath(match.Groups[2].Value))return null;
        string host=Host(match.Groups[1].Value);return host==null?null:host+":"+match.Groups[2].Value;
      }
      var url=Regex.Match(value,@"^([a-z][a-z0-9+.-]*)://([^/?#]+)(/[^?#]*)(?:[?#].*)?$",RegexOptions.IgnoreCase);
      if(!url.Success)return null;string scheme=url.Groups[1].Value.ToLowerInvariant();
      if(Array.IndexOf(new[]{"http","https","ssh","git"},scheme)<0)return null;
      string authority=url.Groups[2].Value;authority=authority.Substring(authority.LastIndexOf('@')+1);
      var parts=Regex.Match(authority,@"^(\[[^\]]+\]|[^:]+)(?::([0-9]{1,5}))?$");
      string path=url.Groups[3].Value;if(!parts.Success||path=="/"||UnsafePath(path))return null;
      string hostName=Host(parts.Groups[1].Value);if(hostName==null)return null;
      string port="";if(parts.Groups[2].Success){int number=int.Parse(parts.Groups[2].Value,CultureInfo.InvariantCulture);if(number<1||number>65535)return null;port=":"+parts.Groups[2].Value;}
      return scheme+"://"+hostName+port+path;
    }
    static IDictionary Failed(string reason){return NativeJson.Object("state","failed","reason",reason,"git_root",null,"remotes",new object[0]);}
    sealed class Remote {public readonly List<string> Url=new List<string>(),Push=new List<string>();}
    sealed class Rewrite {public string Base;public readonly List<string> Prefixes=new List<string>();}
    static string Alias(string value,List<Rewrite> rules) {
      string result=null;int longest=-1;
      foreach(var rule in rules)foreach(string prefix in rule.Prefixes)
        if(value.StartsWith(prefix,StringComparison.Ordinal)&&prefix.Length>longest){longest=prefix.Length;result=rule.Base+value.Substring(prefix.Length);}
      return result;
    }
    static void AddRewrite(List<Rewrite> rules,string baseUrl,string prefix) {
      Rewrite found=null;foreach(var rule in rules)if(rule.Base==baseUrl){found=rule;break;}
      if(found==null){found=new Rewrite{Base=baseUrl};rules.Add(found);}found.Prefixes.Add(prefix);
    }
    static Dictionary<string,object> Run(string git,string workspace,Stopwatch clock,params string[] arguments) {
      int remaining=180-(int)clock.ElapsedMilliseconds;if(remaining<=0)throw new Exception("timeout");
      var command=new List<string>{"-C",workspace};command.AddRange(arguments);
      var result=ProcessRunner.RunGit(git,command.ToArray(),remaining);
      if(clock.ElapsedMilliseconds>=180)throw new Exception("timeout");return result;
    }
    public static IDictionary Observe(string workspace) {
      var clock=Stopwatch.StartNew();
      try {
        string git=Find();if(git==null)return Failed("git_missing");
        var top=Run(git,workspace,clock,"rev-parse","--show-toplevel");
        if((int)top["code"]!=0) {
          string error=(string)top["err"];
          if(Regex.IsMatch(error,@"(^|\n)fatal: not a git repository"))return NativeJson.Object("state","not_git","reason",null,"git_root",null,"remotes",new object[0]);
          if(Regex.IsMatch(error,@"cannot change to|Permission denied|Access is denied"))return Failed("inaccessible");return Failed("git_error");
        }
        string root=Regex.Replace((string)top["out"],@"\r?\n$","");if(NativeJson.ProjectPath(root)==null)return Failed("invalid_git_output");
        var config=Run(git,workspace,clock,"config","--null","--get-regexp",@"^(remote\..*\.(url|pushurl)|url\..*\.(insteadof|pushinsteadof))$");string text=(string)config["out"];
        if((int)config["code"]==1&&text.Length==0)return NativeJson.Object("state","no_remote","reason",null,"git_root",root,"remotes",new object[0]);
        if((int)config["code"]!=0||text.Length==0||!text.EndsWith("\0",StringComparison.Ordinal))return Failed("git_error");
        var entries=new SortedDictionary<string,Remote>(StringComparer.Ordinal);var rewrites=new List<Rewrite>();var pushRewrites=new List<Rewrite>();int configured=0,aliases=0;
        foreach(string line in text.Substring(0,text.Length-1).Split('\0')) {
          if(clock.ElapsedMilliseconds>=180)throw new Exception("timeout");
          int separator=line.IndexOf('\n');if(separator<0)return Failed("invalid_git_output");
          string configKey=line.Substring(0,separator),value=line.Substring(separator+1);
          if(Regex.IsMatch(configKey+value,@"[\x00-\x1f\x7f]"))return Failed("invalid_git_output");
          var alias=Regex.Match(configKey,@"^url\.(.*)\.(insteadof|pushinsteadof)$");
          if(alias.Success){if(++aliases>256)return Failed("output_limit");AddRewrite(alias.Groups[2].Value=="insteadof"?rewrites:pushRewrites,alias.Groups[1].Value,value);continue;}
          var match=Regex.Match(configKey,@"^remote\.(.+)\.(url|pushurl)$");
          if(!match.Success)return Failed("invalid_git_output");if(++configured>64)return Failed("output_limit");string name=match.Groups[1].Value;
          if(name.Length>128)return Failed("invalid_git_output");
          Remote remote;if(!entries.TryGetValue(name,out remote)){remote=new Remote();entries.Add(name,remote);}
          var target=match.Groups[2].Value=="url"?remote.Url:remote.Push;if(value.Length==0)target.Clear();else target.Add(value);
        }
        var remotes=new List<object>();
        // Git remote.c alias_all_urls: explicit push URLs use ordinary
        // rewrites; otherwise matching push rewrites form the push list, and
        // only an empty push list falls back to the rewritten fetch URLs.
        // Reading all effective Git configuration avoids a new process for
        // every remote/direction while retaining all configured addresses.
        foreach(var entry in entries) {
          var fetch=new List<string>();var push=new List<string>();
          foreach(string value in entry.Value.Url)fetch.Add(Alias(value,rewrites)??value);
          if(entry.Value.Push.Count>0)foreach(string value in entry.Value.Push)push.Add(Alias(value,rewrites)??value);
          else {foreach(string value in entry.Value.Url){string alias=Alias(value,pushRewrites);if(alias!=null)push.Add(alias);}if(push.Count==0)push.AddRange(fetch);}
          foreach(string direction in new[]{"fetch","push"})foreach(string value in direction=="fetch"?fetch:push) {
            if(remotes.Count>=64)return Failed("output_limit");
            remotes.Add(NativeJson.Object("address",Address(value)));
          }
        }
        if(clock.ElapsedMilliseconds>=180)throw new Exception("timeout");
        var distinct=new List<object>();var addresses=new List<string>();
        foreach(IDictionary remote in remotes){string address=(string)remote["address"];if(!addresses.Contains(address)){addresses.Add(address);distinct.Add(remote);}}
        return NativeJson.Object("state",remotes.Count>0?"repository":"no_remote","reason",null,"git_root",root,"remotes",distinct.ToArray());
      }catch(Exception error){string reason=error.GetBaseException().Message;if(Array.IndexOf(new[]{"git_missing","timeout","output_limit","invalid_git_output"},reason)<0)reason="git_error";return Failed(reason);}
    }
    public static string Find() {
      foreach(string entry in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')) {
        string directory=entry.Trim('"');if(NativeJson.ProjectPath(directory)==null)continue;
        string candidate=Path.Combine(directory,"git.exe");
        try{var attributes=File.GetAttributes(candidate);if((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0)return candidate;}
        catch(FileNotFoundException){}catch(DirectoryNotFoundException){}
      }
      return null;
    }
  }

  internal static class NativeRuntime {
    static bool Integer(object value,out double number) {
      number=0;if(!(value is long)&&!(value is double))return false;
      number=Convert.ToDouble(value,CultureInfo.InvariantCulture);return !double.IsNaN(number)&&!double.IsInfinity(number)&&Math.Abs(number)<=9007199254740991d&&Math.Truncate(number)==number;
    }
    static bool LiveWriter(string scope) {
      if(scope==null)return false;var match=Regex.Match(scope,@"^windows:([1-9][0-9]{0,9}):([1-9][0-9]{0,18})$");int id;
      if(!match.Success||!int.TryParse(match.Groups[1].Value,out id)||id<=0)return false;
      try{using(var writer=Process.GetProcessById(id)){return !writer.HasExited&&writer.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)==match.Groups[2].Value;}}catch{return false;}
    }
    public static string Generation(IDictionary settings) {
      try {
        string owner=NativeJson.Text(settings,"runtime_owner");object protocol=NativeJson.Value(settings,"protocol_version");
        if(owner==null||!Regex.IsMatch(owner,@"^[a-f0-9]{64}$")||!(protocol is long)||(long)protocol!=2)return null;
        string home=Environment.GetEnvironmentVariable("USERPROFILE");if(string.IsNullOrEmpty(home)||NativeJson.ProjectPath(home)==null)return null;
        string path=Path.Combine(home,".trae-cn","adi-plugin-control","control.json"),cursor=Path.GetFullPath(path);
        while(cursor!=null){if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0)return null;string parent=Path.GetDirectoryName(cursor);if(parent==cursor)break;cursor=parent;}
        var attributes=File.GetAttributes(path);if((attributes&FileAttributes.Directory)!=0||new FileInfo(path).Length>32768)return null;
        var sid=WindowsIdentity.GetCurrent().User;var ownerSid=File.GetAccessControl(path,AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier));if(ownerSid.Value!=sid.Value)return null;
        var control=NativeJson.Decode(File.ReadAllText(path,NativeJson.Utf8),32768,16) as IDictionary;
        if(control==null||!object.Equals(NativeJson.Value(control,"version"),2L)||NativeJson.Text(control,"clock_kind")!="windows-qpc-v1"||!object.Equals(NativeJson.Value(control,"enabled"),true)||NativeJson.Text(control,"owner")!=owner)return null;
        string generation=NativeJson.Text(control,"generation");var leases=NativeJson.Value(control,"leases") as object[];if(!NativeJson.Uuid(generation)||leases==null||leases.Length>128)return null;
        long now=(DateTime.UtcNow.Ticks-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).Ticks)/TimeSpan.TicksPerMillisecond;
        double mono=Math.Floor(Stopwatch.GetTimestamp()*1000.0/Stopwatch.Frequency);
        foreach(object entry in leases){
          var lease=entry as IDictionary;if(lease==null||!NativeJson.Uuid(NativeJson.Text(lease,"id")))continue;
          double issued,expires,monoIssued,monoExpires;
          if(!Integer(NativeJson.Value(lease,"issued_at"),out issued)||!Integer(NativeJson.Value(lease,"expires_at"),out expires)||!Integer(NativeJson.Value(lease,"monotonic_issued_at"),out monoIssued)||!Integer(NativeJson.Value(lease,"monotonic_expires_at"),out monoExpires))continue;
          if(issued>now||expires<=now||expires-issued<=0||expires-issued>30000||monoIssued<0||monoIssued>mono||monoExpires<=mono||monoExpires-monoIssued<=0||monoExpires-monoIssued>30000)continue;
          if(LiveWriter(NativeJson.Text(lease,"clock_scope")))return generation;
        }
      }catch{ }
      return null;
    }
  }

  // Opt-in loopback datagrams only: nonblocking send, no log files or retries.
  internal sealed class NativeDiagnostic {
    string verification,operation;int port;readonly Stopwatch clock;
    public NativeDiagnostic(IDictionary settings,Stopwatch watch){clock=watch;try{
      string home=Environment.GetEnvironmentVariable("USERPROFILE");if(string.IsNullOrEmpty(home)||NativeJson.ProjectPath(home)==null)return;
      string path=Path.Combine(home,".trae-cn","adi-plugin-control","verification.json");
      if(!File.Exists(path)||(File.GetAttributes(path)&(FileAttributes.ReparsePoint|FileAttributes.Directory))!=0||new FileInfo(path).Length>1024)return;
      var marker=NativeJson.Decode(File.ReadAllText(path,NativeJson.Utf8),1024,8) as IDictionary;
      long deadline=Convert.ToInt64(NativeJson.Value(marker,"deadline")),now=(long)(DateTime.UtcNow-NativeJson.Epoch).TotalMilliseconds;
      string id=NativeJson.Text(marker,"verification");int target=Convert.ToInt32(NativeJson.Value(marker,"port"));
      if(!NativeJson.Uuid(id)||target<1024||target>65535||deadline<=now||deadline-now>1800000||NativeJson.Text(marker,"owner")!=NativeJson.Text(settings,"runtime_owner"))return;
      verification=id;port=target;operation=Guid.NewGuid().ToString();
    }catch{}}
    public void Emit(string stage,string phase,string code,int status){if(verification==null||clock.ElapsedMilliseconds>=745)return;try{
      var entry=NativeJson.Object("verification",verification,"operation",operation,"stage",stage,"phase",phase,"elapsed_ms",clock.ElapsedMilliseconds);
      if(code!=null)entry["code"]=code;if(status>=100&&status<=599)entry["http_status"]=status;
      byte[] bytes=NativeJson.Utf8.GetBytes(NativeJson.Encode(entry));
      using(var socket=new Socket(AddressFamily.InterNetwork,SocketType.Dgram,ProtocolType.Udp)){socket.Blocking=false;socket.SendTo(bytes,new IPEndPoint(IPAddress.Loopback,port));}
    }catch{}}
  }

  public static class HookSender {
    public static void Send(string config,Stream input,Stopwatch clock) {
      string observed=DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture);
      var attributes=File.GetAttributes(config);if((attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0||new FileInfo(config).Length>16384)return;
      var settings=NativeJson.Decode(File.ReadAllText(config,NativeJson.Utf8),16384,16) as IDictionary;
      var diagnostic=new NativeDiagnostic(settings,clock);diagnostic.Emit("hook.entry","start",null,0);
      try {
      string installation=NativeJson.Text(settings,"installation_id"),token=NativeJson.Text(settings,"token"),endpoint=NativeJson.Text(settings,"endpoint");
      if(!NativeJson.Uuid(installation)||token==null||!Regex.IsMatch(token,@"^adi_[A-Za-z0-9_-]{43}$")){diagnostic.Emit("hook.error","failed","config_invalid",0);return;}
      string generation=NativeRuntime.Generation(settings);if(generation==null){diagnostic.Emit("hook.runtime","skipped","runtime_unavailable",0);return;}diagnostic.Emit("hook.runtime","success",null,0);settings["runtime_generation"]=generation;
      Uri url;if(!Uri.TryCreate(endpoint,UriKind.Absolute,out url)||!(url.Scheme=="http"||url.Scheme=="https")||string.IsNullOrEmpty(url.Host)||url.AbsolutePath!="/hooks"||url.UserInfo!=""||url.Query!=""||url.Fragment!=""){diagnostic.Emit("hook.error","failed","config_invalid",0);return;}
      diagnostic.Emit("hook.payload","start",null,0);
      string raw;
      using(var memory=new MemoryStream()) {
        byte[] buffer=new byte[65536];int count;
        while((count=input.Read(buffer,0,buffer.Length))>0){if(memory.Length+count>2095104){diagnostic.Emit("hook.payload","skipped","invalid_payload",0);return;}memory.Write(buffer,0,count);}
        raw=NativeJson.Utf8.GetString(memory.ToArray());
      }
      var payload=NativeJson.Decode(raw,2095104,32) as IDictionary;string session=NativeJson.Text(payload,"session_id"),eventName=NativeJson.Text(payload,"hook_event_name");
      if(string.IsNullOrWhiteSpace(session)||session.Length>256||Array.IndexOf(new[]{"SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Stop","Notification"},eventName)<0){diagnostic.Emit("hook.payload","skipped","invalid_payload",0);return;}
      diagnostic.Emit("hook.payload","success",null,0);
      IDictionary project=null;
      // Reserve transport time even when disk/Git stalls. The project phase
      // includes state I/O; Git itself retains its separate 180ms limit.
      // Use the remaining project window instead of discarding a result at an
      // unrelated 350ms cap. State I/O and first-call JIT share this window;
      // transport keeps 200ms and Main still enforces the 750ms total deadline.
      int projectBudget=750-(int)clock.ElapsedMilliseconds-200;
      if(NativeJson.Utf8.GetByteCount(raw)<1700000&&projectBudget>0) {
        int deadline=(int)clock.ElapsedMilliseconds+projectBudget;IDictionary result=null;
        var probe=new Thread(delegate(){try{result=NativeProject.Observe(config,settings,payload,clock,deadline);}catch{}});probe.IsBackground=true;probe.Start();
        if(probe.Join(projectBudget))project=result;
      }
      var header=NativeJson.Object("schema_version",2,"installation_id",installation,"client_event_id",Guid.NewGuid().ToString(),"occurred_at",observed,"timestamp_source","client_observed","event_type",eventName,"source_session_id",session);
      if(project!=null&&NativeJson.Nodes(payload,20000)+NativeJson.Nodes(project,20000)+20<=20000)header["project"]=project;
      string metadata=NativeJson.Encode(header);byte[] body=NativeJson.Utf8.GetBytes(metadata.Substring(0,metadata.Length-1)+",\"payload\":"+raw+"}");
      if(body.Length>2097152&&header.ContainsKey("project")){header.Remove("project");metadata=NativeJson.Encode(header);body=NativeJson.Utf8.GetBytes(metadata.Substring(0,metadata.Length-1)+",\"payload\":"+raw+"}");}
      int remaining=750-(int)clock.ElapsedMilliseconds;if(remaining<=0||body.Length>2097152){diagnostic.Emit("hook.send","skipped","budget_exhausted",0);return;}
      if(NativeRuntime.Generation(settings)!=generation){diagnostic.Emit("hook.send","skipped","runtime_changed",0);return;}
      ServicePointManager.SecurityProtocol|=SecurityProtocolType.Tls12;
      var request=(HttpWebRequest)WebRequest.Create(url);request.Method="POST";request.AllowAutoRedirect=false;request.ContentType="application/json";request.ContentLength=body.Length;
      request.ServicePoint.Expect100Continue=false;
      request.Timeout=Math.Min(header.ContainsKey("project")?350:650,remaining);request.ReadWriteTimeout=request.Timeout;request.Headers["Authorization"]="Bearer "+token;
      diagnostic.Emit("hook.send","start",null,0);
      try{using(var stream=request.GetRequestStream())stream.Write(body,0,body.Length);using(var response=(HttpWebResponse)request.GetResponse()){diagnostic.Emit("hook.response","success",null,(int)response.StatusCode);};}finally{request.Abort();}
      }catch(WebException error){var response=error.Response as HttpWebResponse;diagnostic.Emit("hook.response","failed",error.Status==WebExceptionStatus.Timeout?"timeout":"transport_failed",response==null?0:(int)response.StatusCode);if(response!=null)response.Dispose();}
      catch{diagnostic.Emit("hook.error","failed","hook_failed",0);}
    }
  }
}
