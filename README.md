# tic-tac-toe-worker-node

> Note: I switched back to using Go due to (possibly) performance and memory footprint.

tic-tac-toe-worker-node is the "authoritative server" for the [tic-tac-toe][1]
game. This server is made to be a **distributed server**, which means if there
are 100 of these running, all the works that the client requests will be evenly
distributed among them.

I call this the [Distributed Realtime Server Architecture.][2]

[![architecture][3]][1]

[1]: https://github.com/intagaming/tic-tac-toe

[2]: https://www.hxann.com/blog/posts/distributed-realtime-server

[3]: https://res.cloudinary.com/an7/image/upload/v1657248180/blog/distributed-realtime-architecture-extended_f3olml.png
