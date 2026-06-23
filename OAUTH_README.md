# OAuth Login Feature

## What's New?

Your GPT Extension now supports **OpenAI OAuth login** for secure authentication without manually copying API keys.

## Features

### 🔐 OAuth Login
- One-click authentication with OpenAI
- Secure popup-based login flow
- Automatic API key storage

### 🔑 Manual API Key Entry
- Still supports manual API key input for advanced users
- Perfect for testing and development

### 📊 Authentication Status
- Visual indicator showing current authentication method
- Clear feedback when credentials are saved/removed

## How to Use

### Using OAuth Login (Recommended)

1. Go to **Settings** tab in the extension
2. Click **"🔐 Login with OpenAI"**
3. Authenticate with your OpenAI account in the popup
4. Authorize the application
5. Extension automatically stores your credentials

### Using Manual API Key

1. Go to **Settings** tab
2. Click on **"Get Your API Key"** section
3. Follow the instructions to get your API key from OpenAI
4. Paste it in the **"Enter API Key Manually"** field
5. Click **"Save API Key"**

## Security

✅ **Your data is secure**:
- API keys are stored locally in your browser only
- Never sent to third parties
- You can clear credentials anytime
- Uses Chrome's encrypted storage

## Setup Requirements

To use OAuth login:

1. Backend must have OpenAI OAuth configured
2. See [OAUTH_SETUP.md](./OAUTH_SETUP.md) for backend setup instructions

## Troubleshooting

### OAuth Login not working?

1. Check that backend server is running
2. Verify OpenAI OAuth app is registered
3. Check browser console for error messages
4. Try the manual API key method instead

### Forgot how to get API key?

See the **Settings** tab - it has step-by-step instructions with a direct link to OpenAI.

## Environment Variables Required (Backend)

```
OPENAI_API_KEY=sk-... (for fallback/shared backend)
OPENAI_CLIENT_ID=... (for OAuth)
OPENAI_CLIENT_SECRET=... (for OAuth)
OPENAI_REDIRECT_URI=https://your-domain.com/oauth/callback
```

## Files Added

- `oauth-callback.html` - OAuth popup UI
- `oauth-callback.js` - OAuth callback handler
- `OAUTH_SETUP.md` - Backend configuration guide

## Next Steps

1. Configure OpenAI OAuth in your backend (see OAUTH_SETUP.md)
2. Deploy the updated backend
3. Test OAuth login in the extension
4. Users can now authenticate securely!
