/**
 * Browser config for Airsup (anon key is public; protect data with RLS).
 *
 * Set supabaseAnonKey here OR use config.local.js (see config.local.example.js).
 *
 * No login UI — the app uses Supabase Anonymous sign-ins for a silent session:
 * - Authentication → Providers → Anonymous sign-ins → ON → Save.
 * - Run SQL migrations (003_platform_pivot.sql, 004_profile_trigger_names.sql) so new users get profiles rows.
 *
 * Dev-only: localStorage.setItem("airsup_supabase_anon_key", "<anon key>") then reload.
 */
window.AIRSUP_CONFIG = {
  supabaseUrl: "https://fyxqdwhqposxitexydby.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5eHFkd2hxcG9zeGl0ZXh5ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzk5MDgsImV4cCI6MjA5MTc1NTkwOH0.cvpnWJvVsQx_qEk4hNDAtJZ_M8qNv4RNnhRJBRgulg8",
  apiUrl: "",
};
