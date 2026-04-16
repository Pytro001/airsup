/**
 * Browser config for Airsup (anon key is public; protect data with RLS).
 *
 * Set supabaseAnonKey here OR use config.local.js (see config.local.example.js).
 *
 * Google sign-in checklist (dashboard steps you must complete):
 * 1) Supabase → Authentication → Providers → Google: enable, add OAuth Client ID + secret from Google Cloud.
 * 2) Google Cloud Console → Credentials → your OAuth 2.0 Client → Authorized redirect URIs add:
 *    https://fyxqdwhqposxitexydby.supabase.co/auth/v1/callback
 * 3) Supabase → Authentication → URL Configuration: Site URL = your app origin (e.g. https://yoursite.com or http://localhost:5500).
 *    Add the same origin(s) under Redirect URLs.
 *
 * Dev-only fallback: if the key is still the placeholder, you can set
 * localStorage.setItem("airsup_supabase_anon_key", "<anon key>") in the browser console, then reload.
 */
window.AIRSUP_CONFIG = {
  supabaseUrl: "https://fyxqdwhqposxitexydby.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5eHFkd2hxcG9zeGl0ZXh5ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzk5MDgsImV4cCI6MjA5MTc1NTkwOH0.cvpnWJvVsQx_qEk4hNDAtJZ_M8qNv4RNnhRJBRgulg8",
  apiUrl: "",
};
