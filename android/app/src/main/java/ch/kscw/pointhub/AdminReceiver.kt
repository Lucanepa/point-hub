package ch.kscw.pointhub

import android.app.admin.DeviceAdminReceiver

/**
 * Device-admin receiver, only meaningful when the app is made device owner with
 *   adb shell dpm set-device-owner ch.kscw.pointhub/.AdminReceiver
 * It lives in the root package so that documented command stays short. It needs no legacy
 * policies: lock task, status bar, keyguard and silent installs are all device-owner powers.
 */
class AdminReceiver : DeviceAdminReceiver()
