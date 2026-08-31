import { Amplify } from "aws-amplify";

const DEFAULT_USER_POOL_ID = "us-east-2_Xqdlyxuta";
const DEFAULT_USER_POOL_CLIENT_ID = "7p6qf2p5nd2dfhse4ejk5sdl5o";
const DEFAULT_COGNITO_REGION = "us-east-2";

let isConfigured = false;

export const cognitoConfig = {
  userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || DEFAULT_USER_POOL_ID,
  userPoolClientId:
    process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || DEFAULT_USER_POOL_CLIENT_ID,
  region: process.env.NEXT_PUBLIC_COGNITO_REGION || DEFAULT_COGNITO_REGION,
};

export function configureCognitoAuth() {
  if (isConfigured) {
    return;
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.userPoolClientId,
      },
    },
  });

  isConfigured = true;
}
