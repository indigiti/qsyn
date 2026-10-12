/** Fast, timezone-independent gate for regular NSE/BSE index sessions.
 *  India Standard Time has a fixed UTC+05:30 offset (no DST).
 *  This only suppresses needless reconnects outside standard weekdays;
 *  it does not attest exchange holidays or the Upstox provider's live state.
 */
export function inRegularIndexSession(now=new Date()){
  const ist=new Date(now.getTime()+330*60000);
  const day=ist.getUTCDay();
  const minute=ist.getUTCHours()*60+ist.getUTCMinutes();
  return day>=1&&day<=5&&minute>=9*60+15&&minute<15*60+30;
}
