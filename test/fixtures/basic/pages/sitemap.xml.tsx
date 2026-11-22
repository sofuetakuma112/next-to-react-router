import type { GetServerSideProps } from 'next';
import { allPosts } from '../lib/posts';

export default function Sitemap() {
    return null;
}

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
    const urls = allPosts().map((post) => `<url><loc>https://example.com/posts/${post.id}</loc></url>`);
    res.setHeader('Content-Type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset>${urls.join('')}</urlset>`);
    return { props: {} };
};
