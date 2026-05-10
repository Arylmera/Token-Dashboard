param(
  [Parameter(Mandatory=$true)][string]$TitleMatch,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$CropTop = 0,
  [int]$CropBottom = 0,
  [int]$CropLeft = 0,
  [int]$CropRight = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttr, out RECT pvAttr, int cbAttr);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -match $TitleMatch -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "No window matching '$TitleMatch'"; exit 1 }
$hwnd = $proc.MainWindowHandle

[Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 350

$client = New-Object Win32+RECT
[Win32]::GetClientRect($hwnd, [ref]$client) | Out-Null
$pt = New-Object Win32+POINT
$pt.X = 0; $pt.Y = 0
[Win32]::ClientToScreen($hwnd, [ref]$pt) | Out-Null

$w = $client.Right - $client.Left
$h = $client.Bottom - $client.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($pt.X, $pt.Y, 0, 0, [System.Drawing.Size]::new($w, $h))
$g.Dispose()
if ($CropTop -gt 0 -or $CropBottom -gt 0 -or $CropLeft -gt 0 -or $CropRight -gt 0) {
  $cw = $w - $CropLeft - $CropRight
  $ch = $h - $CropTop - $CropBottom
  $crop = New-Object System.Drawing.Bitmap $cw, $ch
  $cg = [System.Drawing.Graphics]::FromImage($crop)
  $rect = New-Object System.Drawing.Rectangle 0, 0, $cw, $ch
  $src  = New-Object System.Drawing.Rectangle $CropLeft, $CropTop, $cw, $ch
  $cg.DrawImage($bmp, $rect, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $cg.Dispose()
  $crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  $bmp.Dispose()
  Write-Output "$Out ($cw x $ch, cropped from $w x $h)"
} else {
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "$Out ($w x $h)"
}
