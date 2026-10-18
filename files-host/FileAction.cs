using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class DshFileAction {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string name,IntPtr binding,out IntPtr pidl,uint attributes,out uint attributesOut);
 [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr pidl,uint count,IntPtr children,uint flags);
 [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint flags);
 [DllImport("ole32.dll")] static extern void CoUninitialize();
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder text,uint length,uint flags);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 static Form DialogOwner() {
   var owner=new Form();
   owner.Text="DSH 文件操作";owner.ShowInTaskbar=true;owner.FormBorderStyle=FormBorderStyle.FixedDialog;
   owner.Width=420;owner.Height=110;owner.MinimizeBox=false;owner.MaximizeBox=false;owner.StartPosition=FormStartPosition.CenterScreen;owner.TopMost=true;
   try {
     owner.Show();
     // The hidden console startup flag may suppress the process's first show.
     // Show the owner explicitly afterward; do not expose the PowerShell console.
     ShowWindow(owner.Handle,5);owner.Activate();SetForegroundWindow(owner.Handle);Application.DoEvents();
     return owner;
   } catch { owner.Dispose();throw; }
 }
 public static string CheckPath(string file) {
   if(String.IsNullOrWhiteSpace(file) || !Path.IsPathRooted(file))throw new IOException("Invalid path");
   return Path.GetFullPath(file);
 }
 public static bool ChooseApplication(string file) {
   using(var owner=DialogOwner())using(var dialog=new OpenFileDialog()){
     dialog.InitialDirectory=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
     dialog.Title="选择用于打开文件的应用";dialog.Filter="应用程序 (*.exe)|*.exe";
     dialog.CheckFileExists=true;dialog.CheckPathExists=true;dialog.Multiselect=false;dialog.RestoreDirectory=true;
     if(dialog.ShowDialog(owner)!=DialogResult.OK)return false;
     string executable=CheckPath(dialog.FileName);
     if(!File.Exists(executable)||Path.GetExtension(executable).ToLowerInvariant()!=".exe")throw new IOException("Invalid application");
     Process.Start(new ProcessStartInfo(executable,"\""+file+"\""){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Normal});return true;
   }
 }
 public static void Notepad(string file) {
   var allowed=new System.Collections.Generic.HashSet<string>(".txt .md .markdown .json .jsonl .csv .tsv .log .yaml .yml .xml .ini .toml .conf .css .html .htm".Split(' '));
   if(!allowed.Contains(Path.GetExtension(file).ToLowerInvariant()))throw new IOException("Text file required");
   string executable=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"notepad.exe");
   if(!File.Exists(executable))throw new IOException("Notepad unavailable");
   Process.Start(new ProcessStartInfo(executable,"\""+file+"\""){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Normal});
 }
 public static void Reveal(string file) {
   Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero,2));
   try{IntPtr pidl;uint attrs;Marshal.ThrowExceptionForHR(SHParseDisplayName(file,IntPtr.Zero,out pidl,0,out attrs));
     try{Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl,0,IntPtr.Zero,0));}finally{Marshal.FreeCoTaskMem(pidl);}
   }finally{CoUninitialize();}
 }
 public static string Save(string file) {
   using(var owner=DialogOwner())
   using(var dialog=new SaveFileDialog()){
     dialog.InitialDirectory=Path.GetDirectoryName(file);
     dialog.Title="另存为";dialog.FileName=Path.GetFileName(file);dialog.Filter="所有文件 (*.*)|*.*";
     dialog.OverwritePrompt=true;dialog.CheckPathExists=true;dialog.AddExtension=false;dialog.RestoreDirectory=true;
     if(dialog.ShowDialog(owner)!=DialogResult.OK)return null;
     string destination=CheckPath(dialog.FileName);
     if(String.Equals(destination,file,StringComparison.OrdinalIgnoreCase))throw new IOException("Source and destination match");
     string temp=Path.Combine(Path.GetDirectoryName(destination),".dsh-save-"+Guid.NewGuid().ToString("N")+".tmp");
     try{
       // Read without write/delete sharing; verify the opened handle resolves to
       // the same confined source rather than a late junction/symlink target.
       using(var source=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)){
         var resolved=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(source.SafeFileHandle.DangerousGetHandle(),resolved,32768,0);
         if(length==0||length>=32768)throw new IOException("Unable to verify source");
         string actual=resolved.ToString();if(actual.StartsWith(@"\\?\UNC\"))actual=@"\\"+actual.Substring(8);else if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);
         if(!String.Equals(actual,file,StringComparison.OrdinalIgnoreCase))throw new IOException("Source changed");
         using(var output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){source.CopyTo(output);output.Flush(true);}
       }
       if(File.Exists(destination))File.Replace(temp,destination,null);else File.Move(temp,destination);
       return destination;
     }finally{if(File.Exists(temp))File.Delete(temp);}
   }
 }
 public static void Open(string file,string executable) {
   if(executable==null){Process.Start(new ProcessStartInfo(file){UseShellExecute=true,Verb="open",WindowStyle=ProcessWindowStyle.Normal});return;}
   if(!File.Exists(executable)||Path.GetExtension(executable).ToLowerInvariant()!=".exe")throw new IOException("Editor unavailable");
   Process.Start(new ProcessStartInfo(executable,"\""+file+"\""){UseShellExecute=true,WindowStyle=ProcessWindowStyle.Normal});
 }
}

public static class Program {
 [STAThread]
 public static int Main() {
  StreamWriter output=null;
  try {
   output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false));output.AutoFlush=true;
   var input=new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false),false);
   var json=new System.Web.Script.Serialization.JavaScriptSerializer();json.MaxJsonLength=16384;
   var buffer=new char[16385];int count=input.ReadBlock(buffer,0,buffer.Length);
   if(count>16384)throw new InvalidDataException("Request too large");
   var request=json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(new string(buffer,0,count));
   if(request==null)throw new InvalidDataException("Invalid request");
   foreach(var key in request.Keys)if(key!="path"&&key!="action"&&key!="executable")throw new InvalidDataException("Unexpected parameter");
   string action=request.ContainsKey("action")?request["action"] as string:null;
   string file=DshFileAction.CheckPath(request.ContainsKey("path")?request["path"] as string:null);
   bool directory=Directory.Exists(file);
   if(!directory&&!File.Exists(file))throw new FileNotFoundException();
   if(directory&&action!="open"&&action!="reveal")throw new InvalidDataException("File required");
   if(!directory&&(action=="open"||action=="open-with")) {
    var allowed=new System.Collections.Generic.HashSet<string>(".txt .md .json .csv .tsv .html .htm .pdf .docx .xlsx .pptx .odt .ods .odp .jpg .jpeg .png .webp .gif .bmp .tif .tiff .mp4 .mov .mkv .avi .webm .m4v .mp3 .wav .ogg .flac .m4a .aac".Split(' '));
    if(!allowed.Contains(Path.GetExtension(file).ToLowerInvariant()))throw new InvalidDataException("Unsafe type");
   }
   object result;
   switch(action) {
    case "open":DshFileAction.Open(file,null);result=new{ok=true,launched=true};break;
    case "vscode":string editor=request.ContainsKey("executable")?request["executable"] as string:null;if(String.IsNullOrWhiteSpace(editor)||!Path.IsPathRooted(editor))throw new InvalidDataException("Editor required");DshFileAction.Open(file,editor);result=new{ok=true,launched=true};break;
    case "open-with":result=DshFileAction.ChooseApplication(file)?(object)new{ok=true,launched=true}:new{ok=true,cancelled=true};break;
    case "notepad":DshFileAction.Notepad(file);result=new{ok=true,launched=true};break;
    case "reveal":DshFileAction.Reveal(file);result=new{ok=true,launched=true};break;
    case "save-as":string saved=DshFileAction.Save(file);result=saved==null?(object)new{ok=true,cancelled=true}:new{ok=true,saved=true,path=saved,size=new FileInfo(saved).Length};break;
    default:throw new InvalidDataException("Unknown action");
   }
   output.Write(json.Serialize(result));return 0;
  } catch(Exception error) {
   try{var diagnostic=new StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false));diagnostic.AutoFlush=true;diagnostic.WriteLine("FILE_ACTION_ERROR type="+error.GetType().Name+" hresult="+error.HResult);}catch{}
   try{if(output==null){output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false));output.AutoFlush=true;}output.Write("{\"ok\":false,\"error\":\"FILE_ACTION_FAILED\"}");}catch{}
   return 1;
  }
 }
}
