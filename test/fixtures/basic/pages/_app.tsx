import type { AppProps } from 'next/app';
import type { NextPage } from 'next';
import { Inter } from 'next/font/google';
import type { ReactElement, ReactNode } from 'react';
import '../styles/globals.css';

const inter = Inter({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-inter' });

export type NextPageWithLayout<P = {}, IP = P> = NextPage<P, IP> & {
    getLayout?: (page: ReactElement) => ReactNode;
};

type AppPropsWithLayout = AppProps & {
    Component: NextPageWithLayout;
};

export default function App({ Component, pageProps }: AppPropsWithLayout) {
    const getLayout = Component.getLayout ?? ((page) => page);

    return (
        <div className={inter.variable} data-title={pageProps.title ?? ''}>
            {getLayout(<Component {...pageProps} />)}
        </div>
    );
}
