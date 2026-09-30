import pyotp
import requests
import base64
import urllib.parse
from fyers_apiv3 import fyersModel

# =========================================================================
# 1. FYERS CREDENTIALS 
# =========================================================================
client_id = "RMZGEPFSHB-100"
secret_key = "9IIP7EZUO1"
redirect_uri = "https://fyers.in"

fyers_id = "XS79089"                    
fyers_pin = "1819"                        
totp_secret = "QSXXHTM7SPFPMMPCN2SHB6E3G22GUWSN" 
# =========================================================================

def auto_login_fyers():
    print("SP BOT: Auto-Login starting...")
    try:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        
        # --- STEP 1: Init ---
        fy_id_b64 = base64.b64encode(fyers_id.encode()).decode()
        data_init = {"fy_id": fy_id_b64, "app_id": "2"}
        res_init = requests.post("https://api-t2.fyers.in/vagator/v2/send_login_otp_v2", json=data_init, headers=headers).json()
        
        if res_init.get("s") != "ok":
            print("Init Error:", res_init)
            return
        request_key = res_init["request_key"]
        
        # --- STEP 2: TOTP ---
        totp = pyotp.TOTP(totp_secret).now()
        data_totp = {"request_key": request_key, "otp": totp}
        res_totp = requests.post("https://api-t2.fyers.in/vagator/v2/verify_otp", json=data_totp, headers=headers).json()
        
        if res_totp.get("s") != "ok":
            print("TOTP Error:", res_totp)
            return
        request_key = res_totp["request_key"]
        
        # --- STEP 3: PIN ---
        pin_encoded = base64.b64encode(fyers_pin.encode()).decode()
        data_pin = {"request_key": request_key, "identity_type": "pin", "identifier": pin_encoded}
        res_pin = requests.post("https://api-t2.fyers.in/vagator/v2/verify_pin_v2", json=data_pin, headers=headers).json()
        
        if res_pin.get("s") != "ok":
            print("PIN Error:", res_pin)
            return
        sso_token = res_pin["data"]["access_token"]
        
        # --- STEP 4: Auth Code ---
        auth_headers = {"Authorization": f"Bearer {sso_token}", "Content-Type": "application/json"}
        app_id_clean = client_id[:-4] 
        
        data_auth = {
            "fyers_id": fyers_id,
            "app_id": app_id_clean,
            "redirect_uri": redirect_uri,
            "appType": "100",
            "code_challenge": "",
            "state": "None",
            "scope": "",
            "nonce": "",
            "response_type": "code",
            "create_cookie": True
        }
        res_auth = requests.post("https://api-t1.fyers.in/api/v3/token", json=data_auth, headers=auth_headers).json()
        
        if res_auth.get("s") != "ok":
            print("Auth Error:", res_auth)
            return
            
        parsed = urllib.parse.urlparse(res_auth["Url"])
        auth_code = urllib.parse.parse_qs(parsed.query)["auth_code"][0]
        
        # --- STEP 5: Final Token ---
        session = fyersModel.SessionModel(
            client_id=client_id,
            secret_key=secret_key,
            redirect_uri=redirect_uri,
            response_type="code",
            grant_type="authorization_code"
        )
        session.set_token(auth_code)
        response = session.generate_token()
        
        if "access_token" in response:
            with open("fyers_token.txt", "w") as f:
                f.write(response["access_token"])
            print("Login Successful. Token 'fyers_token.txt' me save ho gaya hai.")
        else:
            print("Failed to get access token:", response)
            
    except Exception as e:
        print("Login me koi problem aayi:", e)

if __name__ == "__main__":
    auto_login_fyers()