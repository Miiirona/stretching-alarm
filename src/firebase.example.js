import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// 이 파일을 복사해 src/firebase.js 로 저장한 뒤 실제 값을 입력하세요.
// Firebase 콘솔 → 프로젝트 설정 → 앱 → SDK 설정 및 구성
const firebaseConfig = {
  apiKey:            'YOUR_API_KEY',
  authDomain:        'YOUR_PROJECT_ID.firebaseapp.com',
  projectId:         'YOUR_PROJECT_ID',
  storageBucket:     'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId:             'YOUR_APP_ID',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
