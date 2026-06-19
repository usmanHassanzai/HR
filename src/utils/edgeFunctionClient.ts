import { supabase } from '../lib/supabase';

/**
 * Generic helper to call a Supabase Edge Function.
 * @param functionName Name of the function as defined in supabase/functions.
 * @param payload JSON‑serialisable payload sent to the function.
 * @returns Parsed JSON response from the function.
 */
export async function callEdgeFunction<T>(functionName: string, payload: any): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body: JSON.stringify(payload),
    // Ensure the response is parsed as JSON
    headers: { 'Content-Type': 'application/json' },
  });
  if (error) {
    console.error(`Error invoking edge function ${functionName}:`, error);
    throw error;
  }
  return data as T;
}
