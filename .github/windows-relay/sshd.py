# A stand-in for the Hermes server's sshd: it lets any user in without a key and opens every forward asked for.
import asyncio, asyncssh

class Server(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        return True

async def main():
    key = asyncssh.generate_private_key('ssh-ed25519')
    await asyncssh.create_server(Server, '127.0.0.1', 2222, server_host_keys=[key])
    print('sshd up', flush=True)
    await asyncio.Event().wait()

asyncio.run(main())
