"use client";

import Link from "next/link";
import { Token } from "@/lib/constants";
import { TOKEN_LIST_DEFAULT } from "@/lib/constants";

export default function Coins() {
  const coins = [...TOKEN_LIST_DEFAULT].sort((a: Token, b: Token) =>
    a.name.localeCompare(b.name)
  );

  return (
    <section className="w-full py-12 md:py-24 lg:py-32">
      <div className="flex flex-col items-center justify-center px-4 md:px-6 space-y-4">
        {/* <p className="max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
              Here is the response to your API call:
            </p> */}
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl lg:text-6xl/none">
          {coins.map((coin: Token) => (
            <Link key={coin.id} href={`/${coin.id}`}>
              <img src={coin.logo} alt={coin.name} />
              <p>{coin.name}</p>
              <p>{coin.symbol}</p>
            </Link>
          ))}
        </h1>
      </div>
    </section>
  );
}
