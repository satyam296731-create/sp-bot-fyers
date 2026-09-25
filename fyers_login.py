from fyers_apiv3 import fyersModel
import pyotp

# 1. Fyers Credentials
client_id = "RMZGEPFSHB-100"
secret_key = "9IIP7EZUO1"
redirect_uri = "https://fyers.in"
totp_secret = "N5QOE76X5QWAGERM3NXDFU34W3S25IJV"

# 2. Live TOTP Generate karna
totp = pyotp.TOTP(totp_secret)
print(f"\nTumhara Live Fyers TOTP: {totp.now()} (Login ke waqt yeh daal dena)\n")

# 3. Login URL Setup
session = fyersModel.SessionModel(
    client_id=client_id,
    secret_key=secret_key,
    redirect_uri=redirect_uri,
    response_type="code",
    grant_type="authorization_code"
)

login_url = session.generate_authcode()
print("STEP 1: Is link ko (Ctrl + Click karke) browser me open karo. Apna Fyers ID, PIN aur upar diya gaya TOTP daal kar login karo:")
print(login_url)
print("\nSTEP 2: Login ke baad jab https://fyers.in par redirect hoga, toh upar browser ke URL me 'auth_code=' ke aage ek lamba code hoga. Us code ko copy karke yahan paste karna.\n")

# 4. Access Token Generate aur Save karna
auth_code = input("Browser ke URL se auth_code copy karke yahan paste karo: ")

session.set_token(auth_code)
response = session.generate_token()

if "access_token" in response:
    access_token = response["access_token"]
    print("\n Access Token Successfully Generated!")
    
    # Token ko text file me save kar rahe hain
    with open("fyers_token.txt", "w") as f:
        f.write(access_token)
    print("Token 'fyers_token.txt' me save ho gaya hai. Ab live data le sakte hain!")
else:
    print("\n Error aaya hai:", response)