import { Html, Head, Main, NextScript } from 'next/document';
import Script from 'next/script';

export default function Document() {
    return (
        <Html lang="en">
            <Head>
                <link rel="icon" href="/hero.png" />
                <Script id="early" strategy="beforeInteractive">{`window.__early = true;`}</Script>
            </Head>
            <body className="fixture-body">
                <Main />
                <NextScript />
            </body>
        </Html>
    );
}
