# OAuth Setup Guide

## Overview
This extension supports OpenAI OAuth login for secure authentication without storing API keys directly. This document explains how to set up the OAuth flow on your backend.

## Prerequisites

1. **OpenAI Account**: Create an account at https://platform.openai.com
2. **OAuth Application**: Register an OAuth application with OpenAI
3. **Backend Server**: A server running `backend.js` (Render, Heroku, etc.)

## OpenAI OAuth Setup

### Step 1: Register OAuth Application

1. Visit https://platform.openai.com/account/billing/overview
2. Go to API Keys section
3. Look for OAuth applications settings
4. Register a new OAuth application with:
   - **Name**: GPT Extension
   - **Redirect URI**: `https://gpt-extension.onrender.com/oauth/callback`

### Step 2: Get OAuth Credentials

After registration, you'll receive:
- **Client ID**: Store this safely
- **Client Secret**: Store this safely in environment variables

## Backend Implementation

### Required Environment Variables

```bash
OPENAI_CLIENT_ID=your_client_id_here
OPENAI_CLIENT_SECRET=your_client_secret_here
OPENAI_REDIRECT_URI=https://gpt-extension.onrender.com/oauth/callback
```

### Backend Endpoints

Add these endpoints to your Express backend (`backend.js`):

```javascript
// OAuth Authorization Endpoint
app.get("/oauth/authorize", (req, res) => {
  const redirectUri = encodeURIComponent(process.env.OPENAI_REDIRECT_URI);
  const clientId = process.env.OPENAI_CLIENT_ID;
  const authUrl = `https://platform.openai.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=offline_access`;
  res.redirect(authUrl);
});

// OAuth Callback Handler
app.post("/oauth/callback", async (req, res) => {
  const { code, redirectUri } = req.body;

  try {
    // Exchange code for access token
    const tokenResponse = await fetch("https://api.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.OPENAI_CLIENT_ID,
        client_secret: process.env.OPENAI_CLIENT_SECRET,
        code,
        redirect_uri: process.env.OPENAI_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to exchange code for token");
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Optionally: Get user info to verify auth
    const userResponse = await fetch("https://api.openai.com/v1/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error("Failed to verify user");
    }

    // For this implementation, we return the access token as the API key
    // In production, you might want to:
    // 1. Store tokens in a database
    // 2. Create a unique user identifier
    // 3. Implement token refresh logic

    res.json({
      apiKey: accessToken,
      expiresIn: tokenData.expires_in,
    });
  } catch (error) {
    console.error("OAuth error:", error);
    res.status(500).json({
      error: error.message || "OAuth authentication failed",
    });
  }
});
```

## Security Considerations

⚠️ **Important Security Notes**:

1. **Never expose Client Secret**: Keep `OPENAI_CLIENT_SECRET` private and only on the backend
2. **HTTPS Only**: Always use HTTPS in production
3. **Token Storage**: Tokens should be encrypted if stored
4. **Token Refresh**: Implement token refresh logic for long-lived sessions
5. **CORS**: Configure proper CORS headers for your domain
6. **Rate Limiting**: Implement rate limiting to prevent abuse

## Testing

1. Click "🔐 Login with OpenAI" in the extension settings
2. Authenticate with your OpenAI account
3. Authorize the application
4. The extension will automatically receive and store your API key

## Troubleshooting

### "OAuth timeout" Error
- Check that your backend is running and accessible
- Verify the redirect URI matches your registration

### "No API key returned" Error
- Ensure the backend is correctly exchanging the code for a token
- Check that OpenAI OAuth is enabled in your account

### Extension can't reach backend
- Verify CORS is configured correctly
- Check that the backend URL is correct in `background.js`
- Ensure the backend server is running

## Updating OpenAI OAuth Configuration

If you need to change your OAuth settings:

1. Update `OPENAI_CLIENT_ID` and `OPENAI_CLIENT_SECRET` in your backend
2. Update the redirect URI if hosting URL changes
3. Restart your backend server
4. Update extension if `background.js` endpoints change

## Additional Resources

- [OpenAI API Documentation](https://platform.openai.com/docs)
- [OAuth 2.0 Specification](https://tools.ietf.org/html/rfc6749)
- [Chrome Extension Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
