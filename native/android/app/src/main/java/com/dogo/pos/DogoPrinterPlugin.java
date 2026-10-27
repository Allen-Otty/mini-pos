package com.dogo.pos;

import android.Manifest;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

/**
 * Dogo POS thermal printer bridge for the Android app.
 * Web Bluetooth / WebUSB do not exist inside Android's WebView, so receipts (ESC/POS bytes built in
 * assets/js/hardware.js) are handed to this plugin instead:
 *   - classic Bluetooth printers (SPP / RFCOMM): the printer must first be paired in Android's Bluetooth settings
 *   - USB printers (OTG cable): Android asks the user to allow the device the first time
 * Bluetooth Low Energy printers are handled in JavaScript by @capacitor-community/bluetooth-le.
 */
@CapacitorPlugin(
    name = "DogoPrinter",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class DogoPrinterPlugin extends Plugin {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String ACTION_USB_PERMISSION = "com.dogo.pos.USB_PERMISSION";

    private BluetoothSocket btSocket;
    private String btAddress;

    /* ---------- Android 12+ runtime permission for classic Bluetooth ---------- */
    private boolean needsBtPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED;
    }

    @PermissionCallback
    private void btPermissionCallback(PluginCall call) {
        if (needsBtPermission()) { call.reject("Bluetooth permission was not allowed. Allow \"Nearby devices\" for Dogo POS in Android settings."); return; }
        String m = call.getMethodName();
        if ("btList".equals(m)) btList(call); else if ("btWrite".equals(m)) btWrite(call);
    }

    /* ---------- classic Bluetooth ---------- */
    @PluginMethod
    public void btList(PluginCall call) {
        if (needsBtPermission()) { requestPermissionForAlias("bluetooth", call, "btPermissionCallback"); return; }
        BluetoothAdapter ad = BluetoothAdapter.getDefaultAdapter();
        if (ad == null) { call.reject("This device has no Bluetooth."); return; }
        if (!ad.isEnabled()) { call.reject("Bluetooth is off. Turn it on, then pair the printer in Android's Bluetooth settings."); return; }
        JSArray out = new JSArray();
        try {
            Set<BluetoothDevice> bonded = ad.getBondedDevices();
            for (BluetoothDevice d : bonded) {
                JSObject o = new JSObject();
                o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                o.put("address", d.getAddress());
                out.put(o);
            }
        } catch (SecurityException e) { call.reject("Bluetooth permission was not allowed."); return; }
        JSObject res = new JSObject();
        res.put("devices", out);
        call.resolve(res);
    }

    private synchronized void btEnsure(String address) throws IOException {
        if (btSocket != null && btSocket.isConnected() && address.equals(btAddress)) return;
        btClose();
        BluetoothAdapter ad = BluetoothAdapter.getDefaultAdapter();
        if (ad == null || !ad.isEnabled()) throw new IOException("Bluetooth is off.");
        try {
            BluetoothDevice dev = ad.getRemoteDevice(address);
            ad.cancelDiscovery();
            BluetoothSocket s = dev.createRfcommSocketToServiceRecord(SPP);
            s.connect();
            btSocket = s; btAddress = address;
        } catch (SecurityException e) { throw new IOException("Bluetooth permission was not allowed."); }
    }

    private synchronized void btClose() {
        try { if (btSocket != null) btSocket.close(); } catch (IOException ignored) { }
        btSocket = null; btAddress = null;
    }

    @PluginMethod
    public void btWrite(PluginCall call) {
        if (needsBtPermission()) { requestPermissionForAlias("bluetooth", call, "btPermissionCallback"); return; }
        final String address = call.getString("address");
        final String data = call.getString("data");
        if (address == null || data == null) { call.reject("address and data are required"); return; }
        final byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        try {
            try { writeBt(address, bytes); }
            catch (IOException first) { btClose(); writeBt(address, bytes); } // stale connection: reconnect once
            call.resolve();
        } catch (IOException e) {
            btClose();
            call.reject("Could not reach the Bluetooth printer. Check it is on, in range and paired. (" + e.getMessage() + ")");
        }
    }

    private synchronized void writeBt(String address, byte[] bytes) throws IOException {
        btEnsure(address);
        OutputStream os = btSocket.getOutputStream();
        for (int i = 0; i < bytes.length; i += 512) {
            os.write(bytes, i, Math.min(512, bytes.length - i));
            os.flush();
            try { Thread.sleep(15); } catch (InterruptedException ignored) { }
        }
    }

    /* ---------- USB (OTG) ---------- */
    private UsbManager usb() { return (UsbManager) getContext().getSystemService(Context.USB_SERVICE); }

    @PluginMethod
    public void usbList(PluginCall call) {
        JSArray out = new JSArray();
        for (UsbDevice d : usb().getDeviceList().values()) {
            if (findOut(d) == null) continue; // only devices that can accept print data
            JSObject o = new JSObject();
            o.put("id", d.getDeviceName());
            String n = Build.VERSION.SDK_INT >= 21 ? d.getProductName() : null;
            o.put("name", n != null ? n : ("USB device " + d.getVendorId() + ":" + d.getProductId()));
            o.put("vendorId", d.getVendorId());
            o.put("productId", d.getProductId());
            out.put(o);
        }
        JSObject res = new JSObject();
        res.put("devices", out);
        call.resolve(res);
    }

    /** First bulk-OUT endpoint, preferring the standard printer class (7). Returns {interface, endpoint} or null. */
    private Object[] findOut(UsbDevice d) {
        Object[] best = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface itf = d.getInterface(i);
            for (int j = 0; j < itf.getEndpointCount(); j++) {
                UsbEndpoint ep = itf.getEndpoint(j);
                if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == UsbConstants.USB_DIR_OUT) {
                    if (best == null || (itf.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER && ((UsbInterface) best[0]).getInterfaceClass() != UsbConstants.USB_CLASS_PRINTER)) best = new Object[] { itf, ep };
                }
            }
        }
        return best;
    }

    @PluginMethod
    public void usbWrite(final PluginCall call) {
        final String id = call.getString("id");
        final String data = call.getString("data");
        if (data == null) { call.reject("data is required"); return; }
        final byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        final UsbManager mgr = usb();
        UsbDevice target = null;
        for (UsbDevice d : mgr.getDeviceList().values()) {
            if (findOut(d) == null) continue;
            if (id == null || id.equals(d.getDeviceName())) { target = d; break; }
        }
        if (target == null) { call.reject("USB printer not found. Plug it in with the OTG cable, then pair it again."); return; }
        if (mgr.hasPermission(target)) { doUsbWrite(call, mgr, target, bytes); return; }

        final UsbDevice dev = target;
        final Context ctx = getContext();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                try { ctx.unregisterReceiver(this); } catch (IllegalArgumentException ignored) { }
                if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                    new Thread(new Runnable() { @Override public void run() { doUsbWrite(call, mgr, dev, bytes); } }).start();
                } else call.reject("USB permission was not allowed for the printer.");
            }
        };
        ContextCompat.registerReceiver(ctx, receiver, new IntentFilter(ACTION_USB_PERMISSION), ContextCompat.RECEIVER_NOT_EXPORTED);
        Intent i = new Intent(ACTION_USB_PERMISSION).setPackage(ctx.getPackageName());
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        mgr.requestPermission(dev, PendingIntent.getBroadcast(ctx, 0, i, flags));
    }

    private void doUsbWrite(PluginCall call, UsbManager mgr, UsbDevice d, byte[] bytes) {
        Object[] found = findOut(d);
        if (found == null) { call.reject("This USB device has no printer output channel."); return; }
        UsbInterface itf = (UsbInterface) found[0];
        UsbEndpoint ep = (UsbEndpoint) found[1];
        UsbDeviceConnection conn = mgr.openDevice(d);
        if (conn == null) { call.reject("Could not open the USB printer."); return; }
        try {
            if (!conn.claimInterface(itf, true)) { call.reject("Could not claim the USB printer. Unplug and replug it."); return; }
            int off = 0;
            while (off < bytes.length) {
                int n = Math.min(4096, bytes.length - off);
                byte[] chunk = new byte[n];
                System.arraycopy(bytes, off, chunk, 0, n);
                int sent = conn.bulkTransfer(ep, chunk, n, 5000);
                if (sent < 0) { call.reject("The USB printer stopped responding."); return; }
                off += sent > 0 ? sent : n;
            }
            conn.releaseInterface(itf);
            call.resolve();
        } finally { conn.close(); }
    }
}
