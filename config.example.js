/**
 * Copy to config.js and fill in values, or use config.local.js for the anon key only.
 *
 * Google OAuth (required for “Continue with Google”):
 * - Supabase → Authentication → Providers → Google: turn on; paste Client ID + Client secret from Google Cloud.
 * - Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client (Web application) → Authorized redirect URIs:
 *   https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
 * - Supabase → Authentication → URL Configuration: set Site URL and add Redirect URLs for every origin you use
 *   (production domain and http://localhost:PORT for local dev). Must match the app’s window.location.
 */
window.AIRSUP_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
  apiUrl: "",  // leave empty for same-origin, or set to "http://localhost:3001" for local dev
};
