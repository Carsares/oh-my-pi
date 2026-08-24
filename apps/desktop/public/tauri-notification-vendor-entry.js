// Browser facade for the Tauri notification plugin. Native WebViews cannot
// resolve node_modules package specifiers without a same-origin bundle.
export {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
