export default function Chart({ points }: { points: number[] }) {
    return <svg data-testid="chart" width={points.length * 10} height={20} />;
}
