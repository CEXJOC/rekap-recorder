param([switch]$CheckDisplayMapping)
$ErrorActionPreference = 'Stop'
# Read only Windows window/display metadata. No game memory, pixels or injection.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class RiftGameDisplay {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MonitorInfo {
    public int Size; public Rect Monitor, Work; public int Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Device;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct OutputDesc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Device;
    public Rect Coordinates; public int Attached, Rotation; public IntPtr Monitor;
  }
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory(ref Guid id, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Enumerate(IntPtr self, uint index, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Describe(IntPtr self, out OutputDesc value);
  static T Method<T>(IntPtr obj, int slot) {
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T));
  }
  public static int Find(bool checkDisplayMapping) {
    IntPtr target = checkDisplayMapping ? MonitorFromWindow(GetDesktopWindow(), 1) : IntPtr.Zero;
    if (!checkDisplayMapping) {
    foreach (var p in Process.GetProcessesByName("League of Legends")) {
      using (p) {
        var hwnd = p.MainWindowHandle;
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd) || IsIconic(hwnd)) continue;
        var monitor = MonitorFromWindow(hwnd, 0);
        if (target != IntPtr.Zero && target != monitor) return -1;
        target = monitor;
      }
    }
    }
    if (target == IntPtr.Zero) return -1;
    var info = new MonitorInfo(); info.Size = Marshal.SizeOf(typeof(MonitorInfo));
    if (!GetMonitorInfo(target, ref info)) return -1;
    IntPtr factory = IntPtr.Zero, adapter = IntPtr.Zero;
    var id = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    try {
      if (CreateDXGIFactory(ref id, out factory) < 0) return -1;
      // ddagrab's default adapter is DXGI adapter zero; output indices are not Windows monitor numbers.
      if (Method<Enumerate>(factory, 7)(factory, 0, out adapter) < 0) return -1;
      var outputs = Method<Enumerate>(adapter, 7);
      for (uint i = 0; i < 8; i++) {
        IntPtr output;
        if (outputs(adapter, i, out output) < 0) break;
        try {
          OutputDesc desc;
          if (Method<Describe>(output, 7)(output, out desc) >= 0 && desc.Attached != 0 && desc.Device == info.Device) return (int)i;
        } finally { Marshal.Release(output); }
      }
      return -1;
    } finally { if (adapter != IntPtr.Zero) Marshal.Release(adapter); if (factory != IntPtr.Zero) Marshal.Release(factory); }
  }
}
'@
@{ monitor = [RiftGameDisplay]::Find($CheckDisplayMapping.IsPresent) } | ConvertTo-Json -Compress
