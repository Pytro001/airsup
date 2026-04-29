/**
 * Browser config for Airsup (anon key is public; protect data with RLS).
 *
 * Set supabaseAnonKey here OR use config.local.js (see config.local.example.js).
 *
 * The app starts with Supabase Anonymous sign-in, then users set phone + password (onboarding
 * or Settings) so the home page can sign them in. Configure:
 * - Authentication → Providers → Anonymous sign-ins → ON → Save (the workspace uses it).
 * - Authentication → Providers → Email → must be ON. Phone + password on the home page do not use
 *   a real inbox: they use Supabase "email" auth with a technical address 49XXXXXXXXX@login.airsup
 *   derived from the number. If Email is off, you will see "Email logins are disabled" even for
 *   phone login. (You can still keep the app phone-only: do not add any separate email sign-up form.)
 * - (Recommended) Auth → signups: turn OFF "Confirm email" so @login.airsup users are not asked to
 *   click a link (there is no mailbox at that address).
 * - Passwords use Supabase auth password: default minimum is 6 characters; keep the site copy in sync.
 * - Run SQL migrations (003_platform_pivot.sql, 004_profile_trigger_names.sql) so new users get profiles rows.
 *
 * Dev-only: localStorage.setItem("airsup_supabase_anon_key", "<anon key>") then reload.
 */
window.AIRSUP_CONFIG = {
  supabaseUrl: "https://fyxqdwhqposxitexydby.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5eHFkd2hxcG9zeGl0ZXh5ZGJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNzk5MDgsImV4cCI6MjA5MTc1NTkwOH0.cvpnWJvVsQx_qEk4hNDAtJZ_M8qNv4RNnhRJBRgulg8",
  apiUrl: "",
};
