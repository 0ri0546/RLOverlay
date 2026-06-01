Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class XInput {
    [DllImport("xinput1_4.dll")]
    public static extern int XInputGetState(int dwUserIndex, out XINPUT_STATE pState);
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }
}
'@

while ($true) {
    $s = New-Object XInput+XINPUT_STATE
    $r = [XInput]::XInputGetState(0, [ref]$s)
    Write-Output "$r,$($s.Gamepad.wButtons)"
    Start-Sleep -Milliseconds 50
}